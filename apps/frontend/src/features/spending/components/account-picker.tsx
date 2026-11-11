import { useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@wealthfolio/ui";

export interface AccountPickerOption {
  value: string;
  label: string;
}

/**
 * Account field with a search box. Nothing is preselected: the account is
 * picked from the list or by typing, and typing on the closed field opens the
 * list with that text as the search, like the category field.
 */
export function AccountPicker({
  options,
  value,
  onValueChange,
  trigger,
}: {
  options: AccountPickerOption[];
  value: string;
  onValueChange: (value: string) => void;
  /** The field button; receives the popover trigger props. */
  trigger: ReactElement;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  const openFromKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    } else if (e.key.length === 1 && e.key !== " ") {
      // Keys that land before the search box takes focus still count.
      e.preventDefault();
      setSearch((prev) => (open ? prev + e.key : e.key));
      setOpen(true);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={trigger} onKeyDown={openFromKey} />
      <PopoverContent className="w-(--anchor-width) min-w-60 p-0" align="start">
        <Command>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={t("spending:cashForm.selectAccount")}
          />
          <CommandList>
            <CommandEmpty>{t("common:no_results_found", "No results found.")}</CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.value}
                value={option.label}
                onSelect={() => {
                  onValueChange(option.value);
                  handleOpenChange(false);
                }}
              >
                {option.label}
                {option.value === value && <Icons.Check className="ms-auto h-3.5 w-3.5" />}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
