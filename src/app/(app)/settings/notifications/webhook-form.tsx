"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

import { testWebhookAction, updateWebhookAction } from "./actions";

export function WebhookForm({
  defaults,
  secret,
  canEdit,
}: {
  defaults: { url: string; enabled: boolean };
  secret: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [url, setUrl] = useState(defaults.url);
  const [enabled, setEnabled] = useState(defaults.enabled);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);

  async function save(regenerateSecret = false) {
    setPending(true);
    const result = await updateWebhookAction({
      url,
      enabled,
      regenerateSecret,
    });
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(regenerateSecret ? "Secret regenerated" : "Webhook saved");
    router.refresh();
  }

  async function test() {
    setTesting(true);
    const result = await testWebhookAction();
    setTesting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(
      `Test delivered${result.data.status ? ` (${result.data.status})` : ""}.`,
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="webhook-url">Endpoint URL</FieldLabel>
          <Input
            id="webhook-url"
            type="url"
            inputMode="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/hooks/vigil"
            disabled={!canEdit}
          />
          <FieldDescription>
            Receives a POST for every event. Leave empty to remove.
          </FieldDescription>
        </Field>

        {canEdit && (
          <Field>
            <FieldLabel htmlFor="webhook-secret">Signing secret</FieldLabel>
            <Input
              id="webhook-secret"
              value={secret}
              readOnly
              className="font-mono text-xs"
              aria-label="Webhook signing secret"
              onFocus={(event) => event.currentTarget.select()}
            />
            <FieldDescription>
              Used to compute{" "}
              <code className="font-mono">X-Vigil-Signature</code>. Keep it
              secret.
            </FieldDescription>
          </Field>
        )}

        <Field orientation="horizontal">
          <Switch
            id="webhook-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={!canEdit}
            aria-describedby="webhook-enabled-hint"
          />
          <div>
            <FieldLabel htmlFor="webhook-enabled">Enabled</FieldLabel>
            <FieldDescription id="webhook-enabled-hint">
              Deliver events to the endpoint above.
            </FieldDescription>
          </div>
        </Field>

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />}
              Save webhook
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={test}
              disabled={testing || !defaults.url}
            >
              {testing && <Spinner />}
              Send test event
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="text-muted-foreground ml-auto"
              disabled={pending}
              onClick={() => void save(true)}
            >
              Regenerate secret
            </Button>
          </div>
        )}
      </FieldGroup>
    </form>
  );
}
