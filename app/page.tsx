import type { Metadata } from "next";
import { ProjectDashboard } from "./project-dashboard";

export const metadata: Metadata = {
  description: "A local dashboard for the projects in your Documents folder.",
};

export default function Home() {
  return <ProjectDashboard />;
}
