import type { Metadata } from "next";
import { ArticlesScreen } from "@/components/screens/ArticlesScreen";

export const metadata: Metadata = { title: "Articles" };

export default function Page() {
  return <ArticlesScreen />;
}
