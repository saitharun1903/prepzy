import type { Metadata } from "next";
import { ProfileForm } from "@/components/profile-form";
import { PageHeader } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "Set up" };

export default function OnboardingPage() {
  return (
    <>
      <PageHeader
        eyebrow="Getting started"
        title="Tell Prepzy what you are preparing for"
        description="All optional — it helps Prepzy suggest the right practice. You can change it later."
      />
      <ProfileForm mode="onboarding" />
    </>
  );
}
