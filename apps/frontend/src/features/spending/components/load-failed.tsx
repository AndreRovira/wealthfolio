import { useTranslation } from "react-i18next";

import { Button } from "@wealthfolio/ui";

/** Shown in place of a view whose data did not load, with a way to ask again. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="bg-card border-border/60 flex items-center justify-between gap-3 rounded-xl border p-4 text-xs shadow-sm">
      <span className="text-muted-foreground">{t("spending:tabContent.loadError")}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        {t("common:retry")}
      </Button>
    </div>
  );
}
