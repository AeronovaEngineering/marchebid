import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/chantiers" });
  },
  head: () => ({
    meta: [
      { title: "Métré BTP — Chiffrage et soumissions" },
      {
        name: "description",
        content:
          "Outil interne de chiffrage pour bureau d'études BTP : marchés, catalogue matériel et soumissions.",
      },
      { property: "og:title", content: "Métré BTP — Chiffrage et soumissions" },
      {
        property: "og:description",
        content: "Outil interne de chiffrage pour bureau d'études BTP.",
      },
    ],
  }),
  component: () => null,
});
