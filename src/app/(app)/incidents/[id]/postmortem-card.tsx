"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  NotebookIcon,
  PencilSimpleIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

import { draftPostmortemAction, savePostmortemAction } from "../actions";

interface PostmortemCardProps {
  incidentId: string;
  postmortem: string | null;
  canEdit: boolean;
  aiEnabled: boolean;
}

export function PostmortemCard({
  incidentId,
  postmortem,
  canEdit,
  aiEnabled,
}: PostmortemCardProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(postmortem === null && canEdit);
  const [content, setContent] = useState(postmortem ?? "");
  const [pending, setPending] = useState(false);
  const [drafting, setDrafting] = useState(false);

  async function handleDraft() {
    setDrafting(true);
    const result = await draftPostmortemAction(incidentId);
    setDrafting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setContent(result.data.draft);
    setEditing(true);
    toast.success("Draft generated, review before saving.");
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = content.trim();
    if (trimmed.length === 0) return;

    setPending(true);
    const result = await savePostmortemAction(incidentId, {
      content: trimmed,
    });
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success("Postmortem saved.");
    setEditing(false);
    router.refresh();
  }

  function handleCancel() {
    setContent(postmortem ?? "");
    setEditing(false);
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <NotebookIcon className="text-muted-foreground size-4" aria-hidden />
          Postmortem
        </CardTitle>
        <CardDescription>
          What happened, why, and what changes to prevent it.
        </CardDescription>
        {canEdit && postmortem !== null && !editing && (
          <CardAction>
            <Button variant="ghost" size="xs" onClick={() => setEditing(true)}>
              <PencilSimpleIcon aria-hidden />
              Edit
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <form onSubmit={handleSave} className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="postmortem-content" className="sr-only">
                Postmortem content
              </FieldLabel>
              <Textarea
                id="postmortem-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder={
                  "## Summary\n\nWhat happened, the impact, the root cause and how it was fixed…"
                }
                maxLength={20000}
                className="min-h-48 font-mono"
                required
              />
            </Field>
            <div className="flex justify-end gap-2">
              {aiEnabled && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDraft}
                  disabled={drafting || pending}
                  className="mr-auto"
                >
                  {drafting ? <Spinner /> : <SparkleIcon aria-hidden />}
                  Draft with AI
                </Button>
              )}
              {postmortem !== null && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCancel}
                  disabled={pending}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={pending || content.trim().length === 0}
              >
                {pending && <Spinner />}
                Save postmortem
              </Button>
            </div>
          </form>
        ) : postmortem !== null ? (
          <div className="text-sm/relaxed whitespace-pre-wrap">
            {postmortem}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            No postmortem has been written yet.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
