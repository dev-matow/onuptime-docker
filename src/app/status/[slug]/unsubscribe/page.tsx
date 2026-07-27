import type { Metadata } from "next";

import { db } from "@/db";
import { unsubscribeByToken } from "@/modules/status-pages/subscribers";

import { SubscriptionResult } from "../subscription-result";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false },
};

export default async function UnsubscribePage(
  props: PageProps<"/status/[slug]/unsubscribe">,
) {
  const { slug } = await props.params;
  const { token } = await props.searchParams;
  const result = await unsubscribeByToken(
    db,
    typeof token === "string" ? token : undefined,
  );

  if (!result) {
    return (
      <SubscriptionResult
        title="Link expired or invalid"
        message="This unsubscribe link is no longer valid — you may already be unsubscribed."
        backHref={`/status/${encodeURIComponent(slug)}`}
      />
    );
  }

  return (
    <SubscriptionResult
      title="Unsubscribed"
      message={`${result.email} will no longer receive updates for ${result.pageName}.`}
      backHref={`/status/${encodeURIComponent(result.slug)}`}
    />
  );
}
