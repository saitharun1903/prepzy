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
        description="Every field is optional and can be changed later in your career profile. These answers shape interview question types, starter plans and scheduling."
      />
      <ProfileForm mode="onboarding" />
    </>
  );
}
