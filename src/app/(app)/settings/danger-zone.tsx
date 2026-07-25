"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

import { deleteOrganizationAction } from "./actions";

export function DangerZone({ organizationName }: { organizationName: string }) {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);

  async function handleDelete() {
    setPending(true);
    const result = await deleteOrganizationAction();
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    router.push("/onboarding");
  }

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle>Danger zone</CardTitle>
        <CardDescription>
          Deleting the organization permanently removes its monitors, incidents,
          status page and audit history.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive">Delete organization</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {organizationName}?</DialogTitle>
              <DialogDescription>
                This cannot be undone. Type{" "}
                <strong className="font-mono">{organizationName}</strong> to
                confirm.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="delete-confirmation" className="sr-only">
                Organization name confirmation
              </Label>
              <Input
                id="delete-confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                placeholder={organizationName}
                autoComplete="off"
              />
            </div>
            <DialogFooter>
              <Button
                variant="destructive"
                disabled={confirmation !== organizationName || pending}
                onClick={handleDelete}
              >
                {pending && <Spinner />}
                Permanently delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
