import type { Metadata } from "next";
import { ArchiveScreen } from "@/components/screens/ArchiveScreen";

export const metadata: Metadata = { title: "Archive" };

export default function Page() {
  return <ArchiveScreen />;
}
