import type { Metadata } from "next";
import { AudienceScreen } from "@/components/screens/AudienceScreen";

export const metadata: Metadata = { title: "Audience" };

export default function Page() {
  return <AudienceScreen />;
}
