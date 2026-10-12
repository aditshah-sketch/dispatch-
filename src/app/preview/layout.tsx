import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { DispatchProvider } from "@/lib/client/context";

export const metadata: Metadata = { title: "Preview" };

export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <DispatchProvider mode="preview">
      <AppShell>{children}</AppShell>
    </DispatchProvider>
  );
}
