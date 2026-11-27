import { AccountPicker } from "@/features/spending/components/account-picker";
import { cn } from "@/lib/utils";
import { FormControl, FormField, FormItem, FormLabel, FormMessage, Icons } from "@wealthfolio/ui";
import { useFormContext, type FieldPath, type FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";

export interface AccountSelectOption {
  value: string;
  label: string;
  currency: string;
  accountType?: string;
  /** The account's raw meta (fork: trade fee percentages live there). */
  meta?: string;
  /** The account's group, which a phone's account list is sorted under. */
  group?: string;
  /** Activity restriction level based on account tracking mode. */
  restrictionLevel?: "none" | "limited" | "blocked";
}

interface AccountSelectProps<TFieldValues extends FieldValues = FieldValues> {
  name: FieldPath<TFieldValues>;
  accounts: AccountSelectOption[];
  label?: string;
  placeholder?: string;
}

export function AccountSelect<TFieldValues extends FieldValues = FieldValues>({
  name,
  accounts,
  label,
  placeholder,
}: AccountSelectProps<TFieldValues>) {
  const { t } = useTranslation(["activity", "common"]);
  const resolvedLabel = label ?? t("activity:field_account");
  const resolvedPlaceholder = placeholder ?? t("activity:select_account_placeholder");
  const { control } = useFormContext<TFieldValues>();

  const options = accounts.map((account) => ({
    value: account.value,
    label: `${account.label} (${account.currency})`,
    itemProps: {
      "data-testid": "account-option",
      "data-account-name": account.label,
      "data-account-currency": account.currency,
    },
  }));

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => {
        const selected = options.find((option) => option.value === field.value);
        return (
          <FormItem>
            <FormLabel>{resolvedLabel}</FormLabel>
            {/* Fork: a searchable picker, as the cash form's, so a keyboard finds one of many accounts. */}
            <AccountPicker
              options={options}
              value={field.value ?? ""}
              onValueChange={field.onChange}
              searchPlaceholder={t("common:search_accounts")}
              trigger={
                <FormControl>
                  <button
                    type="button"
                    role="combobox"
                    aria-haspopup="listbox"
                    aria-label={resolvedLabel}
                    data-testid="account-select"
                    className="border-input bg-input-bg dark:bg-input/30 hover:bg-accent/30 ring-offset-background focus:ring-ring h-input-height flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors focus:ring-2 focus:ring-offset-2 focus:outline-none"
                  >
                    <span className={cn("truncate", !selected && "text-muted-foreground")}>
                      {selected?.label ?? resolvedPlaceholder}
                    </span>
                    <Icons.ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
                  </button>
                </FormControl>
              }
            />
            <FormMessage />
          </FormItem>
        );
      }}
    />
  );
}
