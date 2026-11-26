import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormattingProvider, MoneyInput, QuantityInput } from "@wealthfolio/ui";
import { Controller, useForm } from "react-hook-form";
import { describe, expect, it } from "vitest";

function EditForm({ kind }: { kind: "money" | "quantity" }) {
  const { control, setValue } = useForm<{ amount?: number }>({ defaultValues: { amount: 100 } });
  return (
    <>
      <button type="button" onClick={() => setValue("amount", 250)}>
        Fill
      </button>
      <Controller
        control={control}
        name="amount"
        render={({ field }) =>
          kind === "money" ? (
            <MoneyInput value={field.value} onValueChange={(v) => field.onChange(v)} />
          ) : (
            <QuantityInput value={field.value} onValueChange={(v) => field.onChange(v)} />
          )
        }
      />
    </>
  );
}

describe("clearing a financial input inside a form field", () => {
  it.each(["money", "quantity"] as const)("keeps the %s input empty", async (kind) => {
    const user = userEvent.setup();
    render(
      <FormattingProvider locale="en-US">
        <EditForm kind={kind} />
      </FormattingProvider>,
    );
    const input = screen.getByRole<HTMLInputElement>("textbox");
    expect(input).toHaveValue("100");

    await user.click(input);
    await user.keyboard("{End}{Backspace}{Backspace}{Backspace}");

    expect(input).toHaveValue("");

    // A value set from outside after clearing still shows.
    await user.click(screen.getByRole("button", { name: "Fill" }));
    expect(input).toHaveValue("250");

    // Typing again after clearing works as usual.
    await user.click(input);
    await user.keyboard("{End}{Backspace}{Backspace}{Backspace}7");
    expect(input).toHaveValue("7");
  });
});
