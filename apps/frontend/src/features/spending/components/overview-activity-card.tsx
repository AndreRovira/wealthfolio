import { useImperativeHandle, useMemo, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";

import { ActionPalette } from "@/components/action-palette";
import { DashboardCard } from "@/components/dashboard-card";
import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useTaxonomy } from "@/hooks/use-taxonomies";
import { getActivityRestrictionLevel } from "@/lib/activity-restrictions";
import { localizeActivityTypeName } from "@/lib/activity-utils";
import { ActivityType } from "@/lib/constants";
import { useSettingsContext } from "@/lib/settings-provider";
import { getCategoryLabel } from "@/lib/taxonomy-labels";
import type { Account, ActivityDetails, TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ActivityForm } from "@/pages/activity/components/activity-form";
import { MobileActivityForm } from "@/pages/activity/components/mobile-forms/mobile-activity-form";
import { Button, Icons, PrivacyAmount, useDateFormatting } from "@wealthfolio/ui";

import {
  useAssignActivityCategory,
  useCashActivities,
  useUnassignActivityCategory,
} from "../hooks/use-cash-activities";
import { isCreditCardAccountType } from "../lib/constants";
import { INCOME_TAXONOMY, SAVINGS_TAXONOMY, SPENDING_TAXONOMY } from "../lib/spending-grid";
import {
  getTransactionDisplay,
  groupRowsByDay,
  isTransferCashActivity,
  toRowVM,
  type TransactionRowVM,
} from "../lib/transactions-helpers";
import { CashActivityForm } from "./cash-activity-form";
import { CategoryIcon } from "./category-chips";
import { QuickCategorizePopover } from "./quick-categorize-popover";
import { QuickEnvelopePopover } from "./quick-envelope-popover";

const DAYS_BACK = 45;
const ROWS = 12;
const ALL_HREF = "/activities?tab=spending";

/**
 * The dashboard's latest movements: what the Activities spending list shows,
 * cut to the rows that move an envelope, with the same add menu, and a row
 * that opens its form in place.
 */
export function OverviewActivityCard({ ref }: { ref?: Ref<{ openAddForm: () => void }> }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { formatDate } = useDateFormatting();
  const isMobile = useIsMobileViewport();
  const { settings } = useSettingsContext();
  const timezone = settings?.timezone?.trim() || undefined;
  const { accounts = [] } = useAccounts({ filterActive: false });
  const accountById = useMemo(() => new Map(accounts.map((a: Account) => [a.id, a])), [accounts]);

  const startDate = useMemo(() => {
    const from = new Date();
    from.setDate(from.getDate() - DAYS_BACK);
    return from.toISOString();
  }, []);
  const { data: activities = [], isLoading } = useCashActivities({ startDate });

  const spending = useTaxonomy(SPENDING_TAXONOMY);
  const income = useTaxonomy(INCOME_TAXONOMY);
  const savings = useTaxonomy(SAVINGS_TAXONOMY);
  const categories = useMemo(() => {
    const map = new Map<string, TaxonomyCategory>();
    for (const taxonomy of [spending, income, savings]) {
      (taxonomy.data?.categories ?? []).forEach((c) => map.set(c.id, c));
    }
    return map;
  }, [spending.data?.categories, income.data?.categories, savings.data?.categories]);

  const groups = useMemo(() => {
    const rows = activities
      .filter((a) => {
        const display = getTransactionDisplay(a, accountById.get(a.accountId)?.accountType);
        // A move between two cash accounts touches no envelope.
        return !display.isNeutral || a.fromSavings === true;
      })
      .sort((a, b) => b.activityDate.localeCompare(a.activityDate))
      .slice(0, ROWS)
      .map((a) => toRowVM(a, categories));
    return groupRowsByDay(rows, timezone);
  }, [activities, accountById, categories, timezone]);

  const assign = useAssignActivityCategory();
  const unassign = useUnassignActivityCategory();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TransactionRowVM | undefined>();
  const [transfer, setTransfer] = useState<Partial<ActivityDetails> | undefined>();

  const openForm = (row?: TransactionRowVM) => {
    setEditing(row);
    setFormOpen(true);
  };
  useImperativeHandle(ref, () => ({ openAddForm: () => openForm() }), []);
  const editingForForm = editing?.category
    ? {
        ...editing.activity,
        categoryAssignmentId: editing.category.assignmentId,
        categoryTaxonomyId: editing.category.taxonomyId,
        categoryId: editing.category.id,
      }
    : editing?.activity;

  const transferAccounts = useMemo(
    () =>
      accounts
        .filter((a: Account) => !a.isArchived)
        .map((a: Account) => ({
          value: a.id,
          label: a.name,
          currency: a.currency,
          accountType: a.accountType,
          meta: a.meta,
          restrictionLevel: getActivityRestrictionLevel(a),
        })),
    [accounts],
  );
  const startTransfer = (accountId: string) =>
    setTransfer({
      activityType: isCreditCardAccountType(accountById.get(accountId)?.accountType)
        ? ActivityType.TRANSFER_IN
        : ActivityType.TRANSFER_OUT,
      accountId,
    });

  const dayLabel = (date: Date) =>
    formatDate(date, {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(timezone ? { timeZone: timezone } : {}),
    });

  return (
    <>
      <DashboardCard
        title={t("spending:dashboard.recentActivity")}
        padded={false}
        className="overflow-hidden"
        action={
          <div className="flex items-center gap-3">
            <Link
              to={ALL_HREF}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
            >
              {t("spending:dashboard.viewAll")}
            </Link>
            <ActionPalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              groups={[
                {
                  items: [
                    {
                      icon: Icons.Activity,
                      label: t("activity:add_transaction"),
                      onClick: () => openForm(),
                    },
                    {
                      icon: Icons.UploadSimple,
                      label: t("activity:page.import_from_csv"),
                      onClick: () => navigate("/import"),
                    },
                  ],
                },
              ]}
              trigger={
                // A phone has the add button in the page header.
                <Button size="sm" className="hidden sm:inline-flex">
                  <Icons.Plus className="me-2 h-4 w-4" />
                  {t("activity:page.add_activities")}
                </Button>
              }
            />
          </div>
        }
      >
        {groups.length === 0 ? (
          <div className="text-muted-foreground px-4 py-6 text-center text-xs md:px-5">
            {isLoading ? t("common:loading") : t("spending:dashboard.noRecentActivity")}
          </div>
        ) : (
          groups.map((group, gi) => (
            <div
              key={group.key}
              className={cn("px-4 py-3 md:px-5", gi > 0 && "border-border/60 border-t")}
            >
              <div className="text-muted-foreground/70 text-2xs font-semibold tracking-wide uppercase">
                {dayLabel(group.date)}
              </div>
              {group.items.map((row) => {
                const a = row.activity;
                const account = accountById.get(a.accountId);
                const display = getTransactionDisplay(a, account?.accountType);
                const spends = display.isOutflow && !display.isNeutral;
                const payee = (a.notes ?? "").trim() || (
                  <span className="text-muted-foreground italic">
                    {localizeActivityTypeName(t, a.activityType)}
                  </span>
                );
                const titleClass =
                  "text-foreground/90 block w-full truncate text-start text-xs font-medium";
                const category = row.category;
                const categoryName =
                  category && getCategoryLabel(t, category.taxonomyId, category.id, category.name);
                return (
                  <div key={a.id} className="hover:bg-muted/40 -mx-2 rounded-md px-2 py-1.5">
                    <div className="flex items-baseline gap-3">
                      <div className="min-w-0 flex-1">
                        {isTransferCashActivity(a) ? (
                          // A transfer is edited with its other leg, in Activities.
                          <Link to={ALL_HREF} className={titleClass}>
                            {payee}
                          </Link>
                        ) : (
                          <button
                            type="button"
                            className={titleClass}
                            onClick={() => openForm(row)}
                          >
                            {payee}
                          </button>
                        )}
                      </div>
                      <div
                        className={cn(
                          "shrink-0 text-xs font-semibold tabular-nums",
                          display.sign === "+" ? "text-success" : "text-foreground",
                        )}
                      >
                        {display.sign === "+" ? "+" : display.sign && "−"}
                        <PrivacyAmount value={Math.abs(display.safeAmount)} currency={a.currency} />
                      </div>
                    </div>
                    <div className="text-muted-foreground text-2xs flex flex-wrap items-center gap-x-1.5">
                      <span className="whitespace-nowrap">{account?.name}</span>
                      {!display.isNeutral && row.splitCount === 0 && (
                        <QuickCategorizePopover
                          scope={
                            display.isIncome ? "income" : display.isSaving ? "saving" : "expense"
                          }
                          selectedCategoryId={category?.id ?? null}
                          onSelect={(taxonomyId, categoryId) =>
                            assign.mutate({ activityId: a.id, taxonomyId, categoryId })
                          }
                          onClear={() =>
                            category &&
                            unassign.mutate({ activityId: a.id, taxonomyId: category.taxonomyId })
                          }
                          trigger={
                            <button
                              type="button"
                              aria-label={
                                categoryName
                                  ? t("spending:transactions.changeCategory", {
                                      name: categoryName,
                                    })
                                  : t("spending:transactions.assignCategory")
                              }
                              className="hover:bg-muted/60 inline-flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5"
                            >
                              {category ? (
                                <>
                                  <span
                                    className="shrink-0"
                                    style={{ color: category.color ?? undefined }}
                                    aria-hidden="true"
                                  >
                                    <CategoryIcon icon={category.icon} className="h-3 w-3" />
                                  </span>
                                  <span className="truncate">{categoryName}</span>
                                </>
                              ) : (
                                <span className="text-warning truncate italic">
                                  {t("spending:transactions.categorize")}
                                </span>
                              )}
                            </button>
                          }
                        />
                      )}
                      {(spends || display.isIncome || a.fromSavings === true) && (
                        <QuickEnvelopePopover
                          activityId={a.id}
                          categoryId={category?.id ?? null}
                          metadata={a.metadata}
                          isExpense={spends}
                          isIncome={display.isIncome}
                          isReturn={a.fromSavings === true}
                          accountMeta={account?.meta}
                          className="min-w-0"
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </DashboardCard>

      <CashActivityForm
        open={formOpen}
        onOpenChange={setFormOpen}
        activity={editingForForm}
        onTransferClick={startTransfer}
      />
      {transfer &&
        (isMobile ? (
          <MobileActivityForm
            accounts={transferAccounts}
            transferAccounts={transferAccounts}
            activity={transfer}
            open
            onClose={() => setTransfer(undefined)}
            startOnDetails
          />
        ) : (
          <ActivityForm
            accounts={transferAccounts}
            transferAccounts={transferAccounts}
            activity={transfer}
            open
            onClose={() => setTransfer(undefined)}
            hidePicker
          />
        ))}
    </>
  );
}
