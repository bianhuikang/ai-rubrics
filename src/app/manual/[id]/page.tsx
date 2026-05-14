import { ManualCheckClient } from "./manual-check-client";

export default async function ManualCheckPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ url?: string }>;
}) {
  const { id } = await params;
  const { url = "" } = await searchParams;
  return <ManualCheckClient taskId={id} url={url} />;
}
