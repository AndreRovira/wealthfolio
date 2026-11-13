import { fireEvent, render, screen } from "@/test/render";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { CashActivity } from "../types/cash-activity";
import { OverviewActivityCard } from "./overview-activity-card";

const row = (id: string, notes: string, extra: Partial<CashActivity>) =>
  ({
    id,
    accountId: "acc",
    activityDate: "2026-11-12T18:00:00Z",
    activityType: "WITHDRAWAL",
    amount: "50",
    netAmount: -50,
    currency: "MXN",
    notes,
    needsReview: false,
    ...extra,
  }) as unknown as CashActivity;

const activities = [
  row("spend", "Tienda", { cashFlowBucket: "spending" }),
  row("move", "Between my accounts", { cashFlowBucket: "neutral", activityType: "TRANSFER_OUT" }),
  row("back", "Back from the broker", {
    cashFlowBucket: "neutral",
    activityType: "TRANSFER_IN",
    fromSavings: true,
  }),
];

const form = vi.fn((_: { open: boolean; activity?: { id: string } }) => null);

vi.mock("../hooks/use-cash-activities", () => ({
  useCashActivities: () => ({ data: activities, isLoading: false }),
  useAssignActivityCategory: () => ({ mutate: vi.fn() }),
  useUnassignActivityCategory: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/hooks/use-accounts", () => ({
  useAccounts: () => ({ accounts: [{ id: "acc", name: "Mifel", accountType: "CASH" }] }),
}));
vi.mock("@/hooks/use-platform", () => ({
  useIsMobileViewport: () => false,
  usePlatform: () => ({ isMobile: false }),
}));
vi.mock("@/hooks/use-taxonomies", () => ({ useTaxonomy: () => ({ data: { categories: [] } }) }));
vi.mock("@/lib/settings-provider", () => ({ useSettingsContext: () => ({ settings: {} }) }));
vi.mock("./cash-activity-form", () => ({
  CashActivityForm: (props: { open: boolean; activity?: { id: string } }) => form(props),
}));
vi.mock("./quick-envelope-popover", () => ({ QuickEnvelopePopover: () => null }));
vi.mock("./quick-categorize-popover", () => ({ QuickCategorizePopover: () => null }));
vi.mock("@/pages/activity/components/activity-form", () => ({ ActivityForm: () => null }));
vi.mock("@/pages/activity/components/mobile-forms/mobile-activity-form", () => ({
  MobileActivityForm: () => null,
}));

describe("OverviewActivityCard", () => {
  it("lists what moves an envelope and opens a row's form in place", () => {
    render(
      <MemoryRouter>
        <OverviewActivityCard />
      </MemoryRouter>,
    );

    expect(screen.getByText("Back from the broker")).toBeInTheDocument();
    expect(screen.queryByText("Between my accounts")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tienda" }));
    expect(form).toHaveBeenLastCalledWith(
      expect.objectContaining({ open: true, activity: expect.objectContaining({ id: "spend" }) }),
    );
  });
});
