import { createHash } from "node:crypto";

import type { DeliveryOutcome } from "../outbox";
import {
  alertKey,
  httpAttempt,
  isResolution,
  parseJsonBody,
  requireHttpsUrl,
  truncate,
  type ChannelMessage,
  type ChannelProvider,
  type ProviderNet,
  type SecretValues,
} from "./types";

/**
 * Jira Service Management, through the Jira Cloud platform REST API v3.
 *
 * **Not Opsgenie.** JSM's alerting came from Opsgenie, and Opsgenie's
 * own API is the obvious-looking way to build this - but Atlassian ended
 * sale of Opsgenie in June 2025 and shuts it down entirely on 5 April
 * 2027. Building a provider on an API with a published death date would
 * be selling a feature that expires. The platform REST API - create an
 * issue, comment on it, transition it - is the surface Atlassian is
 * migrating customers TO, it is versioned in its path, and it is what a
 * service desk queue is made of anyway.
 *
 * The dedup is real and it is stateless on this side, because the state
 * lives in Jira. Every event derives a label from `alertKey`; before
 * writing anything Vigil asks JQL whether an unfinished issue already
 * carries that label. If one does, the event becomes a comment on it;
 * if none does, a new issue. Recovery comments and then, if the operator
 * named one, applies a transition - so an outage is one ticket that
 * grows and closes, not four tickets nobody reads.
 *
 * Two calls per delivery, both through the same `httpAttempt` as every
 * other provider: the same egress policy, the same classification, the
 * same redaction. A provider with its own HTTP would be a provider with
 * its own security posture.
 */

/** Jira labels cannot contain spaces; a hash gives a fixed alphabet and
 * a fixed length, and stays stable for the life of the cause. */
export function jiraLabel(message: ChannelMessage, rowId: string): string {
  const digest = createHash("sha256")
    .update(alertKey(message, rowId))
    .digest("hex")
    .slice(0, 24);
  return `vigil-${digest}`;
}

/** Jira's rich-text fields are Atlassian Document Format, not strings. */
export function adf(text: string): Record<string, unknown> {
  const paragraphs = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: (paragraphs.length > 0 ? paragraphs : [text || " "]).map(
      (line) => ({
        type: "paragraph",
        content: [{ type: "text", text: truncate(line, 4_000) }],
      }),
    ),
  };
}

function issueBody(message: ChannelMessage): string {
  return [message.text, message.url].filter(Boolean).join("\n\n");
}

function basicAuth(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64")}`;
}

/**
 * The open issue carrying this label, if there is one.
 *
 * `statusCategory != Done` rather than "the newest issue with the
 * label": an outage that recurs a month after the first one was closed
 * should open a new ticket, not reopen a closed one by commenting on
 * it. The dedup window is therefore "while the ticket is still open",
 * which is the window a service desk actually works in.
 */
async function findOpenIssue(
  base: string,
  headers: Record<string, string>,
  projectKey: string,
  label: string,
  secrets: SecretValues,
  net: ProviderNet,
): Promise<{ key: string } | null | DeliveryOutcome> {
  const attempt = await httpAttempt({
    url: `${base}/rest/api/3/search/jql`,
    headers,
    body: JSON.stringify({
      jql: `project = "${projectKey}" AND labels = "${label}" AND statusCategory != Done ORDER BY created DESC`,
      fields: ["key"],
      maxResults: 1,
    }),
    secrets,
    net,
  });
  if (!attempt.ok) return attempt.outcome;
  const parsed = parseJsonBody<{ issues?: { key?: unknown }[] }>(attempt.body);
  const key = parsed?.issues?.[0]?.key;
  return typeof key === "string" ? { key } : null;
}

export const jiraProvider: ChannelProvider = {
  id: "jira",
  label: "Jira Service Management",
  kind: "incident",
  blurb: "Open and update a Jira issue per outage, and close it on recovery.",
  docsUrl:
    "https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/",
  apiVersion: "Jira Cloud REST API v3",
  prerequisite:
    "A Jira Cloud site, an API token for an account that may create issues in the project, and the project key.",
  capabilities: {
    native: true,
    lifecycle: true,
    // False. Jira offers no idempotency key on issue creation, so this
    // provider's correlation is a pre-flight JQL search - which is a
    // different guarantee and a weaker one. Two windows it does not
    // close: a create whose response is lost retries against a search
    // index that has not caught up yet, and can open a second ticket;
    // a comment whose response is lost retries and can comment twice.
    // The lifecycle correlation below is real and is what this provider
    // is for; suppressing a redelivery is not something it can claim.
    duplicateSuppression: false,
    receipt: true,
  },
  fields: [
    {
      key: "siteUrl",
      label: "Site URL",
      type: "url",
      required: true,
      placeholder: "https://example.atlassian.net",
      help: "Your Jira base URL, without /rest.",
    },
    {
      key: "projectKey",
      label: "Project key",
      type: "text",
      required: true,
      placeholder: "OPS",
      help: "The short key in issue ids, for example the OPS in OPS-123.",
    },
    {
      key: "issueType",
      label: "Issue type",
      type: "text",
      required: true,
      placeholder: "Task",
      help: "Must exist in that project. Service desk projects often use [System] Incident.",
    },
    {
      key: "resolveTransition",
      label: "Transition on recovery",
      type: "text",
      placeholder: "Done (optional)",
      help: "Named exactly as in the workflow. Left blank, recovery comments on the issue and leaves it open.",
    },
    {
      key: "email",
      label: "Account email",
      type: "text",
      required: true,
      placeholder: "ops@example.com",
      help: "The Atlassian account the API token belongs to.",
    },
    {
      key: "apiToken",
      label: "API token",
      type: "password",
      secret: true,
      required: true,
      help: "id.atlassian.com, Security, API tokens. Sent as HTTP Basic with the email above.",
    },
  ],
  check(config, secrets) {
    const urlError = requireHttpsUrl(config.siteUrl ?? "", "The site URL");
    if (urlError) return urlError;
    if (!/^[A-Z][A-Z0-9_]{1,9}$/.test(config.projectKey ?? "")) {
      return "A project key is 2 to 10 upper-case letters or digits, for example OPS.";
    }
    if (!config.issueType?.trim()) return "An issue type is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email ?? "")) {
      return "The account email is not a valid address.";
    }
    if (!secrets.apiToken) return "An API token is required.";
    return null;
  },
  destinationSummary(config) {
    try {
      return `Jira ${config.projectKey} on ${new URL(config.siteUrl ?? "").host}`;
    } catch {
      return `Jira ${config.projectKey ?? ""}`.trim();
    }
  },
  async deliver({ config, secrets, message, rowId, net }) {
    const base = (config.siteUrl ?? "").replace(/\/+$/, "");
    const headers = {
      "content-type": "application/json",
      accept: "application/json",
      authorization: basicAuth(config.email ?? "", secrets.apiToken ?? ""),
    };
    const label = jiraLabel(message, rowId);
    const projectKey = config.projectKey ?? "";

    const found = await findOpenIssue(
      base,
      headers,
      projectKey,
      label,
      secrets,
      net,
    );
    // A failed search is the delivery's outcome: retrying the whole
    // delivery is right, and guessing "there is no issue" would open a
    // duplicate ticket every time Jira had a bad minute.
    if (found && "status" in found) return found;

    if (!found) {
      if (isResolution(message)) {
        // Recovery for something that never opened a ticket - the
        // channel was added between the outage and the recovery, or the
        // issue was closed by hand. Nothing to do, and nothing wrong.
        return { status: "delivered", providerMessageId: null };
      }
      const created = await httpAttempt({
        url: `${base}/rest/api/3/issue`,
        headers,
        body: JSON.stringify({
          fields: {
            project: { key: projectKey },
            issuetype: { name: config.issueType },
            summary: truncate(message.title, 250),
            description: adf(issueBody(message)),
            labels: [label],
          },
        }),
        secrets,
        net,
      });
      if (!created.ok) return created.outcome;
      const parsed = parseJsonBody<{ key?: unknown }>(created.body);
      return {
        status: "delivered",
        providerMessageId: typeof parsed?.key === "string" ? parsed.key : null,
      };
    }

    const commented = await httpAttempt({
      url: `${base}/rest/api/3/issue/${encodeURIComponent(found.key)}/comment`,
      headers,
      body: JSON.stringify({
        body: adf(
          [message.title, issueBody(message)].filter(Boolean).join("\n"),
        ),
      }),
      secrets,
      net,
    });
    if (!commented.ok) return commented.outcome;

    if (isResolution(message) && config.resolveTransition) {
      await transitionIssue(
        base,
        headers,
        found.key,
        config.resolveTransition,
        secrets,
        net,
      );
    }
    return { status: "delivered", providerMessageId: found.key };
  },
};

/**
 * Applies a named transition, looking up its id first because the
 * endpoint takes an id and workflows differ per project.
 *
 * Deliberately best-effort, and this is the interesting decision in the
 * file. The comment has already landed by the time this runs, so the
 * notification HAS been delivered; failing the delivery here would make
 * the outbox retry the whole thing and comment on the issue a second
 * time, and then a third. A workflow with no matching transition name -
 * the common misconfiguration - would turn every recovery into six
 * duplicate comments and a failed row. So a transition that does not
 * apply leaves the issue open, which is visible in Jira, rather than
 * corrupting the notification record.
 */
async function transitionIssue(
  base: string,
  headers: Record<string, string>,
  issueKey: string,
  name: string,
  secrets: SecretValues,
  net: ProviderNet,
): Promise<void> {
  const list = await httpAttempt({
    url: `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    method: "GET",
    headers,
    secrets,
    net,
  });
  if (!list.ok) return;
  const parsed = parseJsonBody<{
    transitions?: { id?: unknown; name?: unknown }[];
  }>(list.body);
  const match = parsed?.transitions?.find(
    (t) =>
      typeof t.name === "string" &&
      t.name.toLowerCase() === name.trim().toLowerCase(),
  );
  if (!match || typeof match.id !== "string") return;
  await httpAttempt({
    url: `${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`,
    headers,
    body: JSON.stringify({ transition: { id: match.id } }),
    secrets,
    net,
  });
}
