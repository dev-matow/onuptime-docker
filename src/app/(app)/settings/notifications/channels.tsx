"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { EVENT_CLASSES } from "@/modules/notifications/events";
import type {
  ProviderDescriptor,
  ProviderField,
} from "@/modules/notifications/providers/types";
import type { ChannelView } from "@/modules/notifications/channel-service";

import {
  createChannelAction,
  deleteChannelAction,
  testChannelAction,
  updateChannelAction,
} from "./actions";

/**
 * The channel manager: the list, and one editor dialog that covers
 * every provider. The editor renders whatever fields the provider
 * descriptor declares, so a new provider needs no UI work here.
 *
 * Secret handling: stored secret values never reach this component -
 * `ChannelView.secretKeysSet` only says which keys exist. An editor
 * field for a set secret shows a "saved" placeholder; submitting it
 * blank means "keep what is stored".
 */

interface EditorState {
  channelId?: string;
  name: string;
  provider: string;
  config: Record<string, string>;
  secrets: Record<string, string>;
  events: string[];
  enabled: boolean;
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
    secretKeysSet: [],
  };
}

function editorFor(channel: ChannelView): EditorState {
  return {
    channelId: channel.id,
    name: channel.name,
    provider: channel.provider,
    config: { ...channel.config },
    secrets: {},
    events: [...channel.events],
    enabled: channel.enabled,
    secretKeysSet: channel.secretKeysSet,
  };
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

export function ChannelManager({
  channels,
  providers,
  canEdit,
}: {
  channels: ChannelView[];
  providers: ProviderDescriptor[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const providerById = new Map(providers.map((p) => [p.id, p]));
  const activeProvider = editor ? providerById.get(editor.provider) : undefined;

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
    setDeleting(true);
    const result = await deleteChannelAction({ id });
    setDeleting(false);
    setConfirmingDelete(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Channel deleted");
    router.refresh();
  }

  async function toggleEnabled(channel: ChannelView, enabled: boolean) {
    const result = await updateChannelAction({
      id: channel.id,
      channel: {
        name: channel.name,
        provider: channel.provider,
        config: channel.config,
        secrets: {},
        events: channel.events,
        enabled,
      },
    });
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {channels.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No channels yet. Alerts currently reach organization members by email
          only. Add Slack, Discord, Teams, Telegram, Google Chat, Gotify, ntfy,
          a signed webhook, SMTP or Resend.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {channels.map((channel) => {
            const provider = providerById.get(channel.provider);
            return (
              <li
                key={channel.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{channel.name}</span>
                    <Badge variant="secondary">
                      {provider?.label ?? channel.provider}
                    </Badge>
                    {!channel.enabled && (
                      <Badge variant="outline">Disabled</Badge>
                    )}
                  </div>
                  <p className="text-muted-foreground truncate text-xs">
                    {channel.destination}
                    {" · "}
                    {channel.events
                      .map(
                        (id) =>
                          EVENT_CLASSES.find((c) => c.id === id)?.label ?? id,
                      )
                      .join(", ")}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={channel.enabled}
                      onCheckedChange={(next) =>
                        void toggleEnabled(channel, next)
                      }
                      aria-label={`${channel.name} enabled`}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditor(editorFor(channel))}
                    >
                      Edit
                    </Button>
                    {confirmingDelete === channel.id ? (
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={deleting}
                        onClick={() => void remove(channel.id)}
                      >
                        {deleting && <Spinner />}
                        Really delete?
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground"
                        onClick={() => setConfirmingDelete(channel.id)}
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

      {canEdit && (
        <div>
          <Button
            onClick={() => {
              const first = providers[0];
              if (first) setEditor(emptyEditor(first));
            }}
          >
            Add channel
          </Button>
        </div>
      )}

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
                  <FieldLabel htmlFor="channel-provider">Provider</FieldLabel>
                  <Select
                    value={editor.provider}
                    onValueChange={(id) => {
                      const provider = providerById.get(id);
                      if (provider) setEditor(emptyEditor(provider));
                    }}
                    disabled={Boolean(editor.channelId)}
                  >
                    <SelectTrigger id="channel-provider" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {providers.map((provider) => (
                        <SelectItem key={provider.id} value={provider.id}>
                          {provider.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {editor.channelId ? (
                    <FieldDescription>
                      A channel keeps its provider; add a new channel to switch.
                    </FieldDescription>
                  ) : (
                    activeProvider && (
                      <FieldDescription>
                        <a
                          className="underline underline-offset-2"
                          href={activeProvider.docsUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Provider setup guide
                        </a>
                      </FieldDescription>
                    )
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
                    placeholder="Ops room"
                  />
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
    </div>
  );
}
