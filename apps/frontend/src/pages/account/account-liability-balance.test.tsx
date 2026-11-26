import { render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { AccountLiabilityBalance } from "./account-liability-balance";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/history-chart", () => ({ HistoryChart: () => null }));

const { holdings } = vi.hoisted(() => ({ holdings: { current: [] as unknown[] } }));
vi.mock("@/hooks/use-alternative-assets", () => ({
  useNetWorthHistory: () => ({
    data: [{ date: "2026-11-26", currency: "MXN", breakdown: { "CREDIT_CARD:card-1": 2873 } }],
    isLoading: false,
  }),
  useAlternativeHoldings: () => ({ data: holdings.current }),
}));

const loan = (id: string, value: string, metadata: Record<string, unknown>) => ({
  id,
  kind: "liability",
  marketValue: value,
  metadata,
});

const renderCard = () =>
  render(
    <AccountLiabilityBalance
      accountId="card-1"
      dateRange={undefined}
      today={new Date("2026-11-26")}
      defaultInterval="ALL"
      onIntervalSelect={() => undefined}
    />,
  );

describe("AccountLiabilityBalance", () => {
  it("adds the card's MSI, flat and nested, to the balance owed", () => {
    holdings.current = [
      loan("a", "329.99", { msi_card_account_id: "card-1" }),
      loan("b", "100", { msi: { cardAccountId: "card-1" } }),
      loan("c", "999", { msi_card_account_id: "card-2" }),
    ];
    renderCard();
    expect(screen.getByText("account:msi_pending").parentElement).toHaveTextContent("429.99");
    expect(screen.getByText("account:total_with_msi").parentElement).toHaveTextContent("3,302.99");
  });

  it("shows no MSI line for a card without MSI", () => {
    holdings.current = [loan("c", "999", { msi_card_account_id: "card-2" })];
    renderCard();
    expect(screen.queryByText("account:msi_pending")).not.toBeInTheDocument();
  });
});
