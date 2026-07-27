"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { PaperPlaneRightIcon, SparkleIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

import {
  postIncidentUpdateAction,
  suggestStatusUpdateAction,
} from "../actions";

export function UpdateComposer({
  incidentId,
  aiEnabled,
}: {
  incidentId: string;
  aiEnabled: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [internal, setInternal] = useState(false);
  const [pending, setPending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (trimmed.length === 0) return;

    setPending(true);
    const result = await postIncidentUpdateAction(incidentId, {
      message: trimmed,
      internal,
    });
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setMessage("");
    toast.success(internal ? "Internal note added." : "Update posted.");
    router.refresh();
  }

  async function handleSuggest() {
    setSuggesting(true);
    const result = await suggestStatusUpdateAction(incidentId);
    setSuggesting(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setMessage(result.data.suggestion);
    toast.success("Suggestion ready — edit before posting.");
  }

  return (
    <Card size="sm">
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="incident-update" className="sr-only">
              Post an update
            </FieldLabel>
            <Textarea
              id="incident-update"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Share progress with the team — what do you know now?"
              maxLength={2000}
              rows={3}
            />
          </Field>
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
            <label className="text-muted-foreground mr-auto flex items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={internal}
                onChange={(event) => setInternal(event.target.checked)}
                className="accent-primary size-4"
              />
              Internal note (hidden from the public status page)
            </label>
            {aiEnabled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleSuggest}
                disabled={suggesting || pending}
              >
                {suggesting ? <Spinner /> : <SparkleIcon aria-hidden />}
                Suggest update
              </Button>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={pending || message.trim().length === 0}
            >
              {pending ? <Spinner /> : <PaperPlaneRightIcon aria-hidden />}
              {internal ? "Add note" : "Post update"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
