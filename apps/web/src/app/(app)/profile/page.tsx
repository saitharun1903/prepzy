import type { Metadata } from "next";
import { ProfileForm } from "@/components/profile-form";
import { PageHeader } from "@/components/ui/primitives";
import { ConfirmedSkills } from "./confirmed-skills";

export const metadata: Metadata = { title: "Career profile" };

export default function ProfilePage() {
  return (
    <>
      <PageHeader title="Career profile" description="Your goals and the skills you confirm yourself. Elevate uses these alongside your resume when comparing you with a job." />
      <div className="flex flex-col gap-12">
        <ProfileForm mode="profile" />
        <ConfirmedSkills />
      </div>
    </>
  );
}
