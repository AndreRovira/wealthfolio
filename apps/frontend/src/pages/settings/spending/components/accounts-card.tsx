import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { updateAccount } from "@/adapters";

import { useAccounts } from "@/hooks/use-accounts";
import { useNameComparator } from "@/hooks/use-name-comparator";
import type { Account } from "@/lib/types";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
  Switch,
} from "@wealthfolio/ui";

import {
  useSpendingSettings,
  useSpendingSettingsMutation,
} from "@/features/spending/hooks/use-spending-settings";
import { isCreditCardAccountType, isSpendingAccountType } from "@/features/spending/lib/constants";
import { AccountType } from "@/lib/constants";
import { SettingsList, SettingsListMedia, SettingsListRow } from "@/components/settings-list";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";

export function AccountsCard() {
  const { t } = useTranslation();
  const compareNames = useNameComparator();
  const { settings } = useSpendingSettings();
  const mutation = useSpendingSettingsMutation();
  const { accounts, refetch } = useAccounts({ filterActive: false });
  // Fork: per-account "outside envelopes" flag, kept in the account meta.
  // Plain async: the card's tests render it without a QueryClientProvider.
  const [flagBusy, setFlagBusy] = useState(false);
  const toggleEnvelopes = async (account: Account, excluded: boolean) => {
    setFlagBusy(true);
    try {
      let meta: Record<string, unknown> = {};
      try {
        meta = account.meta ? (JSON.parse(account.meta) as Record<string, unknown>) : {};
      } catch {
        meta = {};
      }
      meta.envelopesExcluded = excluded;
      await updateAccount({
        id: account.id,
        name: account.name,
        group: account.group ?? undefined,
        accountNumber: account.accountNumber ?? undefined,
        isDefault: account.isDefault,
        isActive: account.isActive,
        isArchived: account.isArchived,
        accountType: account.accountType,
        currency: account.currency,
        trackingMode: account.trackingMode,
        meta: JSON.stringify(meta),
      });
      await refetch();
    } finally {
      setFlagBusy(false);
    }
  };
  const isExcluded = (account: Account) => {
    try {
      return account.meta ? Boolean(JSON.parse(account.meta).envelopesExcluded) : false;
    } catch {
      return false;
    }
  };

  const accountIds = useMemo(() => settings?.accountIds ?? [], [settings?.accountIds]);
  const initialAccountIdsRef = useRef<string[] | null>(null);
  if (settings && initialAccountIdsRef.current === null) {
    initialAccountIdsRef.current = settings.accountIds;
  }
  // Initial load groups tracked accounts first; later toggle changes should not move rows.
  const sortAccountIds = initialAccountIdsRef.current ?? accountIds;

  const spendingAccounts = useMemo<Account[]>(() => {
    const initiallyTracked = new Set(sortAccountIds);
    return (accounts ?? [])
      .filter((a) => isSpendingAccountType(a.accountType))
      .sort((a, b) => {
        const aTracked = initiallyTracked.has(a.id) ? 0 : 1;
        const bTracked = initiallyTracked.has(b.id) ? 0 : 1;
        if (aTracked !== bTracked) return aTracked - bTracked;
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return compareNames(a.name, b.name);
      });
  }, [accounts, sortAccountIds, compareNames]);

  const includedAccounts = useMemo(
    () => spendingAccounts.filter((a) => accountIds.includes(a.id)),
    [spendingAccounts, accountIds],
  );

  const hasMixedCashAndCredit = useMemo(() => {
    const hasCash = includedAccounts.some((a) => a.accountType === AccountType.CASH);
    const hasCredit = includedAccounts.some((a) => isCreditCardAccountType(a.accountType));
    return hasCash && hasCredit;
  }, [includedAccounts]);

  const handleToggle = (id: string, next: boolean) => {
    const nextIds = next
      ? Array.from(new Set([...accountIds, id]))
      : accountIds.filter((x) => x !== id);
    mutation.mutate({ accountIds: nextIds });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-lg">
          {t("settings:spending.accounts.title")}
        </CardTitle>
        <CardDescription>{t("settings:spending.accounts.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {spendingAccounts.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t("settings:spending.accounts.empty")}
          </p>
        ) : (
          <>
            <SettingsList label={t("settings:spending.accounts.title")}>
              {spendingAccounts.map((account) => {
                const tracked = accountIds.includes(account.id);
                const isCredit = isCreditCardAccountType(account.accountType);
                const typeLabel = isCredit
                  ? t("settings:spending.accounts.type_credit_card")
                  : t("settings:spending.accounts.type_cash");
                const TypeIcon = isCredit ? Icons.CreditCard : Icons.Wallet;
                return (
                  <li key={account.id}>
                    <SettingsListRow
                      inactive={!tracked}
                      media={
                        <SettingsListMedia>
                          <TypeIcon weight="duotone" />
                        </SettingsListMedia>
                      }
                      title={account.name}
                      badges={
                        !account.isActive && (
                          <Badge variant="secondary">
                            {t("settings:spending.accounts.inactive_badge")}
                          </Badge>
                        )
                      }
                      meta={
                        <>
                          {typeLabel} · {account.currency}
                          {account.group ? ` · ${account.group}` : ""}
                          {!tracked && ` · ${t("settings:spending.accounts.not_tracked")}`}
                          {tracked && (
                            <>
                              {" · "}
                              <button
                                type="button"
                                className="underline-offset-2 hover:underline"
                                disabled={flagBusy}
                                onClick={() => void toggleEnvelopes(account, !isExcluded(account))}
                              >
                                {isExcluded(account)
                                  ? t("settings:spending.accounts.outside_envelopes")
                                  : t("settings:spending.accounts.inside_envelopes")}
                              </button>
                            </>
                          )}
                        </>
                      }
                      actions={
                        <Switch
                          checked={tracked}
                          onCheckedChange={(next) => handleToggle(account.id, next)}
                          disabled={mutation.isPending}
                          aria-label={
                            tracked
                              ? t("settings:spending.accounts.stop_tracking_aria", {
                                  name: account.name,
                                })
                              : t("settings:spending.accounts.track_aria", { name: account.name })
                          }
                        />
                      }
                    />
                  </li>
                );
              })}
            </SettingsList>

            {hasMixedCashAndCredit && (
              <Alert variant="warning" className="mt-4 p-2.5 text-xs">
                <Icons.AlertTriangle className="size-3.5" />
                <AlertDescription className="leading-relaxed">
                  {t("settings:spending.accounts.mixed_warning")}
                </AlertDescription>
              </Alert>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
