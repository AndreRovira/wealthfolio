import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormProvider, useForm } from "react-hook-form";
import { AccountSelect, type AccountSelectOption } from "../account-select";

// jsdom has neither; the picker's command list uses both.
if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

interface FormValues {
  accountId: string;
  currency: string;
  fxRate?: number | null;
}

interface TestHarnessProps {
  defaultValues: FormValues;
  accounts: AccountSelectOption[];
}

function TestHarness({ defaultValues, accounts }: TestHarnessProps) {
  const form = useForm<FormValues>({ defaultValues });
  const currency = form.watch("currency");

  return (
    <FormProvider {...form}>
      <AccountSelect<FormValues> name="accountId" accounts={accounts} />
      <div data-testid="account-value">{form.watch("accountId")}</div>
      <div data-testid="currency-value">{currency}</div>
      <output data-testid="fx-rate">{JSON.stringify(form.watch("fxRate"))}</output>
      <button type="button" onClick={() => form.setValue("accountId", "acc-usd")}>
        Select USD account
      </button>
    </FormProvider>
  );
}

const accounts: AccountSelectOption[] = [
  { value: "acc-eur", label: "EUR Account", currency: "EUR" },
  { value: "acc-usd", label: "USD Account", currency: "USD" },
  { value: "acc-bbva", label: "BBVA Nomina", currency: "MXN" },
];

describe("AccountSelect", () => {
  it("changes only the account, leaving currency and FX to the activity form", async () => {
    const user = userEvent.setup();
    render(
      <TestHarness
        accounts={accounts}
        defaultValues={{ accountId: "acc-eur", currency: "GBP", fxRate: 1.2 }}
      />,
    );
    await user.click(screen.getByTestId("account-select"));
    await user.click(await screen.findByRole("option", { name: "USD Account (USD)" }));
    expect(screen.getByTestId("account-value")).toHaveTextContent("acc-usd");
    expect(screen.getByTestId("currency-value")).toHaveTextContent("GBP");
    expect(screen.getByTestId("fx-rate")).toHaveTextContent("1.2");
  });
  it("does not fill currency on mount", () => {
    render(
      <TestHarness accounts={accounts} defaultValues={{ accountId: "acc-eur", currency: "" }} />,
    );
    expect(screen.getByTestId("currency-value")).toBeEmptyDOMElement();
  });

  it("finds an account by typing on the closed field", async () => {
    const user = userEvent.setup();
    render(<TestHarness accounts={accounts} defaultValues={{ accountId: "", currency: "" }} />);
    screen.getByTestId("account-select").focus();
    await user.keyboard("bbva");
    expect(await screen.findByRole("option", { name: "BBVA Nomina (MXN)" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "EUR Account (EUR)" })).toBeNull();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("account-value")).toHaveTextContent("acc-bbva");
    expect(screen.getByTestId("account-select")).toHaveTextContent("BBVA Nomina (MXN)");
  });
});
