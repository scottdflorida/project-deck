import type { Metadata } from "next";
import { ProjectDashboard } from "./project-dashboard";

export const metadata: Metadata = {
  description: "A local working-set register for projects on this computer.",
};

export default function Home() {
  return <ProjectDashboard />;
}
