// src/routes/_authenticated/import.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { PageHeader } from "@/components/ui/pageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { CatalogueImportPanel } from "@/components/Catalogueimportpanel";

export const Route = createFileRoute("/_authenticated/import")({
  component: ImportComponent,
});

function ImportComponent() {
  const navigate = useNavigate();

  const goToCatalogue = () => navigate({ to: "/catalogue" });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import catalogue"
        description="Importez des articles depuis un fichier CSV ou Excel."
      />

      <Card>
        <CardContent className="p-6">
          <CatalogueImportPanel onCancel={goToCatalogue} onImported={goToCatalogue} />
        </CardContent>
      </Card>
    </div>
  );
}