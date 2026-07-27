import type { Metadata } from "next";

import { db } from "@/db";
import { confirmSubscription } from "@/modules/status-pages/subscribers";

import { SubscriptionResult } from "../subscription-result";

export const metadata: Metadata = {
  title: "Confirm subscription",
  robots: { index: false },
};

export default async function ConfirmSubscriptionPage(
  props: PageProps<"/status/[slug]/confirm">,
) {
  const { slug } = await props.params;
  const { token } = await props.searchParams;
  const result = await confirmSubscription(
    db,
    typeof token === "string" ? token : undefined,
  );

  if (!result) {
    return (
      <SubscriptionResult
        title="Link expired or invalid"
        message="This confirmation link is no longer valid. Try subscribing again from the status page."
        backHref={`/status/${encodeURIComponent(slug)}`}
      />
    );
  }

  return (
    <SubscriptionResult
      title="Subscription confirmed"
      message={`${result.email} will now receive incident updates for ${result.pageName}. You can unsubscribe from any of those emails.`}
      backHref={`/status/${encodeURIComponent(result.slug)}`}
    />
  );
}
