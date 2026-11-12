import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createActivity } from "@/adapters";
import { assignActivityCategory } from "@/features/spending/adapters/cash-activities";
import { applyIncome, getEnvelopeSnapshot } from "@/features/spending/adapters/envelopes";
import { DECIMAL_PRECISION } from "@/lib/constants";
import { ActivityCreate } from "@/lib/types";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useTranslation } from "react-i18next";

/** REVALUATION books a FEE tagged Investment > Revaluation, so a frozen-in-MXN
 *  foreign account that drops takes the loss out of the Investment envelope. */
export type BalanceUpdateKind = "DEPOSIT" | "WITHDRAWAL" | "INTEREST" | "FEE" | "REVALUATION";

export interface BalanceUpdateInput {
  currency: string;
  currentBalance: number;
  targetBalance: number;
  /** How to book the difference; defaults to a deposit or withdrawal. */
  activityType?: BalanceUpdateKind;
}

export const useBalanceUpdate = (accountId: string) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async ({
      currency,
      currentBalance,
      targetBalance,
      activityType,
    }: BalanceUpdateInput) => {
      const difference = targetBalance - currentBalance;
      if (
        !accountId.trim() ||
        !currency.trim() ||
        !Number.isFinite(currentBalance) ||
        !Number.isFinite(targetBalance) ||
        !Number.isFinite(difference) ||
        targetBalance < 0
      ) {
        throw new Error(t("account:balance_edit.invalid_amount"));
      }

      const amount = parseFloat(Math.abs(difference).toFixed(DECIMAL_PRECISION));
      if (amount === 0) return;

      // Don't set assetId - backend generates CASH:{currency} for cash activities.
      const newActivity: ActivityCreate = {
        accountId,
        activityType:
          activityType === "REVALUATION"
            ? "FEE"
            : (activityType ?? (difference > 0 ? "DEPOSIT" : "WITHDRAWAL")),
        activityDate: new Date().toISOString(),
        currency,
        amount,
        comment: "Balance updated manually",
      };

      const created = await createActivity(newActivity);
      // Fork: interest is income the on-income rules can route; a category
      // is what makes them see it.
      if (activityType === "INTEREST" && created?.id) {
        await assignActivityCategory(created.id, "income_sources", "cat_income_interest").catch(
          () => undefined,
        );
        // The income rule already says where interest goes: apply its split
        // here, so the deposit does not wait on the envelopes page for a click.
        // Only a split that hands out exactly this deposit: a rule with fixed
        // lines would fund them in full out of a few cents of interest. That
        // one, like any failure, stays pending there, as it did before.
        try {
          const pending = (await getEnvelopeSnapshot()).pendingIncome.find(
            (p) => p.activityId === created.id,
          );
          const handsOutDeposit =
            pending?.proposed.every((line) => line.amount >= 0) &&
            Math.abs(
              pending.proposed.reduce((sum, line) => sum + line.amount, 0) - pending.amount,
            ) < 0.01;
          if (pending && handsOutDeposit) {
            await applyIncome({
              ruleId: pending.ruleId,
              activityId: pending.activityId,
              entryDate: pending.date,
              splits: pending.proposed,
            });
            void queryClient.invalidateQueries({ queryKey: ["spending_envelopes"] });
          }
        } catch {
          // left pending
        }
      }
      if (activityType === "REVALUATION" && created?.id) {
        await assignActivityCategory(
          created.id,
          "spending_categories",
          "cat_investment_revaluation",
        ).catch(() => undefined);
      }
      return created;
    },
    retry: false,
    onError: () => {
      toast({
        title: t("account:balance_edit.error"),
        variant: "destructive",
      });
    },
    onSuccess: (activity) => {
      if (!activity) return;
      toast({
        title: t("account:balance_edit.success"),
        variant: "default",
      });
    },
  });

  return { ...mutation, updateBalance: mutation.mutateAsync };
};
