"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EVENT_CLASSES } from "@/modules/notifications/events";
import type {
  ChannelPage,
  ChannelSummary,
  ChannelView,
} from "@/modules/notifications/channel-service";
import {
  PROVIDER_KINDS,
  PROVIDER_KIND_LABELS,
} from "@/modules/notifications/providers/kinds";
import type {
  ProviderDescriptor,
  ProviderField,
} from "@/modules/notifications/providers/types";

import {
  createChannelAction,
  deleteChannelAction,
  duplicateChannelAction,
  getChannelAction,
  setChannelsEnabledAction,
  testChannelAction,
  updateChannelAction,
} from "./actions";

/**
 * The channel list and one editor dialog covering every provider.
 *
 * Built for an unbounded number of rows: filtering and paging happen in
 * the database (this component only ever holds one page), the editor is
 * fetched per channel rather than embedded in every row, and no secret
 * value reaches the browser in either path.
 */

interface MonitorOption {
  id: string;
  name: string;
}

interface EditorState {
  channelId?: string;
  name: string;
  provider: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  events: string[];
  enabled: boolean;
  scopedToMonitors: boolean;
  monitorIds: string[];
  secretKeysSet: string[];
}

function emptyEditor(provider: ProviderDescriptor): EditorState {
  return {
    name: provider.label,
    provider: provider.id,
    config: {},
    secrets: {},
    events: ["monitor", "incident"],
    enabled: true,
    scopedToMonitors: false,
    monitorIds: [],
    secretKeysSet: [],
  };
}

function editorFrom(view: ChannelView): EditorState {
  return {
    channelId: view.id,
    name: view.name,
    provider: view.provider,
    config: { ...view.config },
    secrets: {},
    events: [...view.events],
    enabled: view.enabled,
    scopedToMonitors: view.scopedToMonitors,
    monitorIds: [...view.monitorIds],
    secretKeysSet: view.secretKeysSet,
  };
}

/**
 * What a provider can do, as badges.
 *
 * Two of these change how an operator should wire the channel, so they
 * are worth the pixels: `lifecycle` means recovery CLOSES the alert
 * rather than sending a second one, which is why a pager wants the
 * monitor class and not just incidents. `native: false` is the Apprise
 * bridge, and it says so in the words the docs use, because "Vigil
 * integrates with everything Apprise supports" is the claim this label
 * exists to prevent anyone making.
 */
function CapabilityBadges({ provider }: { provider: ProviderDescriptor }) {
  const { capabilities: c } = provider;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {!c.native && (
        <Badge variant="outline" className="text-foreground">
          Bridge, not a Vigil integration
        </Badge>
      )}
      {c.lifecycle && <Badge variant="secondary">Resolves on recovery</Badge>}
      {c.duplicateSuppression && (
        <Badge variant="secondary">Collapses retries</Badge>
      )}
      {c.receipt && <Badge variant="secondary">Returns a receipt</Badge>}
    </div>
  );
}

function FieldInput({
  field,
  state,
  onChange,
}: {
  field: ProviderField;
  state: EditorState;
  onChange: (next: EditorState) => void;
}) {
  const id = `channel-${field.key}`;
  const isSaved =
    Boolean(field.secret) && state.secretKeysSet.includes(field.key);
  const value = field.secret
    ? (state.secrets[field.key] ?? "")
    : (state.config[field.key] ?? "");
  const set = (next: string) =>
    onChange(
      field.secret
        ? { ...state, secrets: { ...state.secrets, [field.key]: next } }
        : { ...state, config: { ...state.config, [field.key]: next } },
    );

  if (field.type === "textarea") {
    return (
      <Field>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <Textarea
          id={id}
          rows={4}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          value={value}
          onChange={(event) => set(event.target.value)}
          placeholder={
            isSaved ? "saved - leave blank to keep" : (field.placeholder ?? "")
          }
        />
        {field.help && <FieldDescription>{field.help}</FieldDescription>}
      </Field>
    );
  }

  if (field.type === "select") {
    return (
      <Field>
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <Select value={value} onValueChange={set}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Choose…" />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {field.help && <FieldDescription>{field.help}</FieldDescription>}
      </Field>
    );
  }

  return (
    <Field>
      <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
      <Input
        id={id}
        type={field.type === "password" ? "password" : "text"}
        inputMode={field.type === "url" ? "url" : undefined}
        autoComplete="off"
        value={value}
        onChange={(event) => set(event.target.value)}
        placeholder={
          isSaved ? "saved - leave blank to keep" : (field.placeholder ?? "")
        }
      />
      {field.help && <FieldDescription>{field.help}</FieldDescription>}
    </Field>
  );
}

/**
 * What happened to this channel's last delivery.
 *
 * The labels are spelled out rather than falling through to the raw
 * enum, which is what 1.18.0's three new terminal states did until the
 * screenshot caught it: a channel showed `dead_letter` in a badge. The
 * three unhappy endings read differently on purpose - "rejected" is a
 * misconfiguration, "gave up" ran out of attempts, "too late" ran out
 * of horizon, and an operator does something different about each.
 */
const LAST_RESULT_LABEL: Record<string, string> = {
  queued: "Retrying",
  sending: "Sending",
  delivered: "Delivered",
  failed: "Rejected",
  dead_letter: "Gave up",
  expired: "Too late",
};

function StateBadge({ row }: { row: ChannelSummary }) {
  if (!row.enabled) return <Badge variant="outline">Disabled</Badge>;
  const last = row.lastResult;
  if (!last) return <Badge variant="secondary">No sends yet</Badge>;
  const label = LAST_RESULT_LABEL[last.state] ?? last.state;
  if (last.state === "delivered") return <Badge>{label}</Badge>;
  if (
    last.state === "failed" ||
    last.state === "dead_letter" ||
    last.state === "expired"
  ) {
    return <Badge variant="destructive">{label}</Badge>;
  }
  return <Badge variant="secondary">{label}</Badge>;
}

export function ChannelManager({
  page,
  pageNumber,
  pageSize,
  providers,
  monitors,
  filters,
  canEdit,
}: {
  page: ChannelPage;
  pageNumber: number;
  pageSize: number;
  providers: ProviderDescriptor[];
  monitors: MonitorOption[];
  filters: { search: string; provider: string; status: string };
  canEdit: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pendingNav, startNav] = useTransition();

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [opening, setOpening] = useState(false);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [search, setSearch] = useState(filters.search);
  const [picking, setPicking] = useState(false);
  const [providerQuery, setProviderQuery] = useState("");

  const providerById = new Map(providers.map((p) => [p.id, p]));
  const activeProvider = editor ? providerById.get(editor.provider) : undefined;
  const monitorById = new Map(monitors.map((m) => [m.id, m.name]));
  const totalPages = Math.max(Math.ceil(page.total / pageSize), 1);
  const nativeCount = providers.filter((p) => p.capabilities.native).length;

  /**
   * The picker matches label, blurb and API version, so "pager",
   * "webhook" and "v2" all find something. A dropdown of twenty-six
   * entries is a list you scroll past; a search over what they DO is a
   * list you find things in.
   */
  const providerMatches = providers.filter((provider) => {
    const q = providerQuery.trim().toLowerCase();
    if (!q) return true;
    return `${provider.label} ${provider.blurb} ${provider.apiVersion} ${provider.kind}`
      .toLowerCase()
      .includes(q);
  });

  function choose(provider: ProviderDescriptor) {
    setPicking(false);
    setProviderQuery("");
    setEditor(emptyEditor(provider));
  }

  /** Filters live in the URL, so a filtered list is linkable and the
   * back button behaves. Every change resets to page one. */
  function navigate(patch: Record<string, string>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!("page" in patch)) next.delete("page");
    startNav(() => router.push(`/settings/notifications?${next.toString()}`));
  }

  async function openEditor(id: string) {
    setOpening(true);
    const result = await getChannelAction({ id });
    setOpening(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setEditor(editorFrom(result.data));
  }

  async function save() {
    if (!editor) return;
    setPending(true);
    const payload = {
      name: editor.name,
      provider: editor.provider,
      config: editor.config,
      secrets: editor.secrets,
      events: editor.events,
      enabled: editor.enabled,
      // Always sent, so "switch this back to the whole workspace" is an
      // empty list rather than an absent field the service would ignore.
      monitorIds: editor.scopedToMonitors ? editor.monitorIds : [],
    };
    const result = editor.channelId
      ? await updateChannelAction({ id: editor.channelId, channel: payload })
      : await createChannelAction(payload);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(editor.channelId ? "Channel saved" : "Channel added");
    setEditor(null);
    router.refresh();
  }

  async function test() {
    if (!editor) return;
    setTesting(true);
    const result = await testChannelAction({
      name: editor.name,
      provider: editor.provider,
      config: editor.config,
      secrets: editor.secrets,
      ...(editor.channelId ? { channelId: editor.channelId } : {}),
    });
    setTesting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Test delivered.");
  }

  async function remove(id: string) {
    setBusy(true);
    const result = await deleteChannelAction({ id });
    setBusy(false);
    setConfirmingDelete(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    toast.success("Channel deleted");
    router.refresh();
  }

  async function duplicate(id: string) {
    setBusy(true);
    const result = await duplicateChannelAction({ id });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Copied. The copy is disabled until you enable it.");
    router.refresh();
  }

  async function bulkEnable(enabled: boolean) {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true);
    const result = await setChannelsEnabledAction({ ids, enabled });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(
      `${result.data.changed} channel${result.data.changed === 1 ? "" : "s"} ${
        enabled ? "enabled" : "disabled"
      }.`,
    );
    setSelected(new Set());
    router.refresh();
  }

  async function toggleOne(row: ChannelSummary, enabled: boolean) {
    const result = await setChannelsEnabledAction({ ids: [row.id], enabled });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    router.refresh();
  }

  const allOnPageSelected =
    page.rows.length > 0 && page.rows.every((row) => selected.has(row.id));

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>Channels</CardTitle>
            <span className="text-muted-foreground text-xs">
              {page.totalUnfiltered} configured
            </span>
          </div>
          <CardDescription>
            Where alerts go beyond member email. Add as many as you need,
            including several of the same kind: one Slack per client, one
            webhook per system. There is no limit on how many you configure; how
            fast they deliver depends on your server and on what each provider
            accepts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            <form
              className="flex-1 basis-52"
              onSubmit={(event) => {
                event.preventDefault();
                navigate({ q: search });
              }}
            >
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search name or destination"
                aria-label="Search channels"
              />
            </form>
            <Select
              value={filters.provider || "all"}
              onValueChange={(v) =>
                navigate({ provider: v === "all" ? "" : v })
              }
            >
              <SelectTrigger className="w-40" aria-label="Filter by provider">
                <SelectValue placeholder="All providers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All providers</SelectItem>
                {PROVIDER_KINDS.map((kind) => {
                  const group = providers.filter((p) => p.kind === kind);
                  if (group.length === 0) return null;
                  return (
                    <SelectGroup key={kind}>
                      <SelectLabel>{PROVIDER_KIND_LABELS[kind]}</SelectLabel>
                      {group.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
            <Select
              value={filters.status || "all"}
              onValueChange={(v) => navigate({ status: v === "all" ? "" : v })}
            >
              <SelectTrigger className="w-36" aria-label="Filter by status">
                <SelectValue placeholder="Any status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any status</SelectItem>
                <SelectItem value="enabled">Enabled</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectContent>
            </Select>
            {canEdit && (
              <Button onClick={() => setPicking(true)}>Add channel</Button>
            )}
          </div>

          {/* Bulk bar */}
          {canEdit && selected.size > 0 && (
            <div className="bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
              <span>{selected.size} selected</span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void bulkEnable(true)}
              >
                Enable
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void bulkEnable(false)}
              >
                Disable
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </div>
          )}

          {/* List */}
          {page.rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {page.totalUnfiltered === 0
                ? `No channels yet. Alerts reach organization members by email only. Add channel connects any of ${nativeCount} providers - chat, on-call, push, SMS, email or a signed webhook.`
                : "No channels match these filters."}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {canEdit && (
                <li className="flex items-center gap-2 px-1 pb-1">
                  <Checkbox
                    checked={allOnPageSelected}
                    onCheckedChange={(next) =>
                      setSelected((prev) => {
                        const copy = new Set(prev);
                        for (const row of page.rows) {
                          if (next) copy.add(row.id);
                          else copy.delete(row.id);
                        }
                        return copy;
                      })
                    }
                    aria-label="Select all on this page"
                  />
                  <span className="text-muted-foreground text-xs">
                    Select page
                  </span>
                </li>
              )}
              {page.rows.map((row) => {
                const provider = providerById.get(row.provider);
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3"
                  >
                    {canEdit && (
                      <Checkbox
                        checked={selected.has(row.id)}
                        onCheckedChange={(next) =>
                          setSelected((prev) => {
                            const copy = new Set(prev);
                            if (next) copy.add(row.id);
                            else copy.delete(row.id);
                            return copy;
                          })
                        }
                        aria-label={`Select ${row.name}`}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{row.name}</span>
                        <Badge variant="secondary">
                          {provider?.label ?? row.provider}
                        </Badge>
                        <StateBadge row={row} />
                      </div>
                      <p className="text-muted-foreground truncate text-xs">
                        {row.destination || provider?.label || row.provider}
                        {" · "}
                        {!row.scopedToMonitors
                          ? "All monitors"
                          : row.targetCount === 0
                            ? "No monitors left"
                            : `${row.targetCount} monitor${row.targetCount === 1 ? "" : "s"}`}
                        {" · "}
                        {row.events
                          .map(
                            (id) =>
                              EVENT_CLASSES.find((c) => c.id === id)?.label ??
                              id,
                          )
                          .join(", ")}
                      </p>
                      {row.scopedToMonitors && row.targetCount === 0 && (
                        <p className="text-foreground mt-0.5 text-xs">
                          Every monitor this channel was scoped to has been
                          deleted, so it receives nothing. Pick monitors, or
                          switch it to the whole workspace.
                        </p>
                      )}
                      {row.lastResult?.error && (
                        <p
                          className="text-muted-foreground mt-0.5 truncate text-xs"
                          title={row.lastResult.error}
                        >
                          Last error: {row.lastResult.error}
                        </p>
                      )}
                    </div>
                    {canEdit && (
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={row.enabled}
                          onCheckedChange={(next) => void toggleOne(row, next)}
                          aria-label={`${row.name} enabled`}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={opening}
                          onClick={() => void openEditor(row.id)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void duplicate(row.id)}
                        >
                          Duplicate
                        </Button>
                        {confirmingDelete === row.id ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy}
                            onClick={() => void remove(row.id)}
                          >
                            {busy && <Spinner />}
                            Really delete?
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            onClick={() => setConfirmingDelete(row.id)}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {/* Pager */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                Page {pageNumber} of {totalPages} · {page.total} matching
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pageNumber <= 1 || pendingNav}
                  onClick={() => navigate({ page: String(pageNumber - 1) })}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pageNumber >= totalPages || pendingNav}
                  onClick={() => navigate({ page: String(pageNumber + 1) })}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* The provider picker.
       *
       * A dialog rather than a longer dropdown, because twenty-six
       * entries in a Select is a list you scroll past rather than choose
       * from. Search covers what each one DOES as well as its name, the
       * groups give the list a shape at 390px, and each row shows the
       * API version and the capabilities that change how you would wire
       * it - so the decision is made here rather than after a failed
       * test delivery. */}
      <Dialog
        open={picking}
        onOpenChange={(open) => {
          setPicking(open);
          if (!open) setProviderQuery("");
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a provider</DialogTitle>
            <DialogDescription>
              {nativeCount} providers Vigil implements directly, plus a bridge
              to an Apprise server you run.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={providerQuery}
            onChange={(event) => setProviderQuery(event.target.value)}
            placeholder="Search providers"
            aria-label="Search providers"
            autoFocus
          />
          <div className="flex flex-col gap-3">
            {PROVIDER_KINDS.map((kind) => {
              const group = providerMatches.filter((p) => p.kind === kind);
              if (group.length === 0) return null;
              return (
                <div key={kind} className="flex flex-col gap-1">
                  <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                    {PROVIDER_KIND_LABELS[kind]}
                  </p>
                  {group.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => choose(provider)}
                      className="hover:bg-muted/60 focus-visible:ring-ring flex flex-col gap-1 rounded-md border p-2 text-left focus-visible:ring-2 focus-visible:outline-none"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {provider.label}
                        </span>
                        <Badge
                          variant="outline"
                          className="font-mono text-[11px]"
                        >
                          {provider.apiVersion}
                        </Badge>
                      </span>
                      <span className="text-muted-foreground text-xs">
                        {provider.blurb}
                      </span>
                      <CapabilityBadges provider={provider} />
                    </button>
                  ))}
                </div>
              );
            })}
            {providerMatches.length === 0 && (
              <p className="text-muted-foreground text-sm">
                Nothing matches that. Anything Vigil does not implement natively
                can still be reached through the Apprise bridge, using an
                Apprise server you run.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editor?.channelId ? "Edit channel" : "Add channel"}
            </DialogTitle>
            <DialogDescription>
              {activeProvider?.blurb ?? "Choose where alerts go."}
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel>Provider</FieldLabel>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {activeProvider?.label ?? editor.provider}
                    </span>
                    <Badge variant="outline" className="font-mono text-[11px]">
                      {activeProvider?.apiVersion}
                    </Badge>
                    {!editor.channelId && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={() => setPicking(true)}
                      >
                        Change
                      </Button>
                    )}
                  </div>
                  {activeProvider && (
                    <CapabilityBadges provider={activeProvider} />
                  )}
                  {activeProvider && (
                    <FieldDescription>
                      {activeProvider.prerequisite}{" "}
                      <a
                        className="underline underline-offset-2"
                        href={activeProvider.docsUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Provider setup guide
                      </a>
                    </FieldDescription>
                  )}
                  {editor.channelId && (
                    <FieldDescription>
                      A channel keeps its provider; add a new channel to switch.
                    </FieldDescription>
                  )}
                </Field>

                <Field>
                  <FieldLabel htmlFor="channel-name">Name</FieldLabel>
                  <Input
                    id="channel-name"
                    value={editor.name}
                    onChange={(event) =>
                      setEditor({ ...editor, name: event.target.value })
                    }
                    placeholder="Slack - Operations"
                  />
                  <FieldDescription>
                    Yours to choose, and worth choosing well once there is more
                    than one of a provider: &ldquo;Slack - Operations&rdquo; and
                    &ldquo;Slack - Client A&rdquo; read better in a list than
                    two rows called Slack.
                  </FieldDescription>
                </Field>

                {(activeProvider?.fields ?? []).map((field) => (
                  <FieldInput
                    key={`${editor.provider}-${field.key}`}
                    field={field}
                    state={editor}
                    onChange={setEditor}
                  />
                ))}

                <Field>
                  <FieldLabel>Send</FieldLabel>
                  <div className="flex flex-col gap-2">
                    {EVENT_CLASSES.map((cls) => {
                      const checked = editor.events.includes(cls.id);
                      return (
                        <label
                          key={cls.id}
                          className="flex items-start gap-2 text-sm"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(next) =>
                              setEditor({
                                ...editor,
                                events: next
                                  ? [...editor.events, cls.id]
                                  : editor.events.filter((e) => e !== cls.id),
                              })
                            }
                            className="mt-0.5"
                          />
                          <span>
                            {cls.label}
                            <span className="text-muted-foreground block text-xs">
                              {cls.description}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </Field>

                <Field>
                  <FieldLabel htmlFor="channel-scope">For</FieldLabel>
                  <Select
                    value={editor.scopedToMonitors ? "some" : "all"}
                    onValueChange={(value) =>
                      setEditor({
                        ...editor,
                        scopedToMonitors: value === "some",
                        monitorIds: value === "all" ? [] : editor.monitorIds,
                      })
                    }
                  >
                    <SelectTrigger id="channel-scope" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">
                        Every monitor in this workspace
                      </SelectItem>
                      <SelectItem value="some" disabled={monitors.length === 0}>
                        Only the monitors I pick
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Workspace-wide channels also receive events that belong to
                    no monitor, such as a manually reported incident.
                  </FieldDescription>
                  {editor.scopedToMonitors && (
                    <div className="mt-1 flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                      {monitors.map((monitor) => (
                        <label
                          key={monitor.id}
                          className="flex items-center gap-2 text-sm"
                        >
                          <Checkbox
                            checked={editor.monitorIds.includes(monitor.id)}
                            onCheckedChange={(next) =>
                              setEditor({
                                ...editor,
                                monitorIds: next
                                  ? [...editor.monitorIds, monitor.id]
                                  : editor.monitorIds.filter(
                                      (id) => id !== monitor.id,
                                    ),
                              })
                            }
                          />
                          <span className="truncate">{monitor.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  {editor.scopedToMonitors && editor.monitorIds.length > 0 && (
                    <FieldDescription>
                      {editor.monitorIds
                        .map((id) => monitorById.get(id) ?? id)
                        .slice(0, 3)
                        .join(", ")}
                      {editor.monitorIds.length > 3
                        ? ` and ${editor.monitorIds.length - 3} more`
                        : ""}
                    </FieldDescription>
                  )}
                </Field>

                <Field orientation="horizontal">
                  <Switch
                    id="channel-enabled"
                    checked={editor.enabled}
                    onCheckedChange={(next) =>
                      setEditor({ ...editor, enabled: next })
                    }
                  />
                  <div>
                    <FieldLabel htmlFor="channel-enabled">Enabled</FieldLabel>
                    <FieldDescription>
                      Disabled channels keep their configuration but receive
                      nothing.
                    </FieldDescription>
                  </div>
                </Field>

                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={pending}>
                    {pending && <Spinner />}
                    {editor.channelId ? "Save channel" : "Add channel"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void test()}
                    disabled={testing}
                  >
                    {testing && <Spinner />}
                    Send test
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => setEditor(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </FieldGroup>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
