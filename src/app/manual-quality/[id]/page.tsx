import { ManualQualityReviewClient } from "./quality-review-client";

export default async function ManualQualityReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ url?: string }>;
}) {
  const { id } = await params;
  const { url = "" } = await searchParams;
  return <ManualQualityReviewClient taskId={id} url={url} />;
}
