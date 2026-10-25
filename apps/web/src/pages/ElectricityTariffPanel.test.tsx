import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ElectricityInvoiceReconciliation, House } from "@climate-twin/contracts";
import { api, ApiRequestError } from "../api";
import { ConfirmationProvider } from "../components/ConfirmationProvider";
import { queryClient } from "../data/queryClient";
import { I18nProvider } from "../i18n";
import { ElectricityBillCheckPanel } from "./ElectricityBillCheckPanel";
import { ElectricityTariffPanel } from "./ElectricityTariffPanel";

const legacyTariff = {
  timeZone: "Europe/Helsinki",
  tariff: {
    propertyId: "property-main",
    revision: 0,
    updatedAt: "2026-07-01T00:00:00.000Z",
    versions: [{
      validFrom: "2000-01-01", energy: { kind: "spot" as const, marginCentsPerKwh: 0.5 }, network: null,
      electricityTaxCentsPerKwh: null, retailerMonthlyFeeEur: null, networkMonthlyFeeEur: null,
    }],
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

describe("ElectricityTariffPanel", () => {
  it("adds a dated fixed day/night version and saves it against the loaded revision", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "propertyElectricityTariff").mockResolvedValue(legacyTariff);
    const save = vi.spyOn(api, "savePropertyElectricityTariff").mockImplementation(async (_propertyId, versions) => ({
      timeZone: "Europe/Helsinki",
      tariff: { ...legacyTariff.tariff, revision: 1, versions },
    }));
    render(<I18nProvider><ElectricityTariffPanel propertyId="property-main" readOnly={false} /></I18nProvider>);

    expect(await screen.findByText("Spot + 0.5 c/kWh")).not.toBeNull();
    expect(screen.getByText(/earlier contract settings/)).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Add version" }));
    const date = screen.getByLabelText("Valid from");
    await user.clear(date);
    await user.type(date, "2026-11-01");
    await user.selectOptions(screen.getByLabelText("Energy price"), "fixed");
    await user.selectOptions(screen.getByLabelText("Rate structure"), "day_night");
    await user.type(screen.getByLabelText("Day rate (c/kWh)"), "12,5");
    await user.type(screen.getByLabelText("Night rate (c/kWh)"), "8");
    await user.selectOptions(screen.getByLabelText("Transfer charge"), "flat");
    await user.type(screen.getByLabelText("Rate (c/kWh)"), "4.1");
    await user.type(screen.getByLabelText("Electricity tax (c/kWh)"), "2.82");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    const table = screen.getByRole("table");
    expect(within(table).getByText("Day 12.5 / night 8 c/kWh")).not.toBeNull();
    expect(screen.getByText("Unsaved changes")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Save tariff" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith("property-main", [
      legacyTariff.tariff.versions[0],
      {
        validFrom: "2026-11-01",
        energy: { kind: "fixed", schedule: { kind: "day_night", dayCentsPerKwh: 12.5, nightCentsPerKwh: 8 } },
        network: { kind: "flat", centsPerKwh: 4.1 },
        electricityTaxCentsPerKwh: 2.82,
        retailerMonthlyFeeEur: null,
        networkMonthlyFeeEur: null,
      },
    ], 0));
    expect(await screen.findByText(/Tariff saved/)).not.toBeNull();
  });

  it("rejects a second version on the same date and keeps at least one version", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "propertyElectricityTariff").mockResolvedValue(legacyTariff);
    render(<I18nProvider><ElectricityTariffPanel propertyId="property-main" readOnly={false} /></I18nProvider>);
    await screen.findByText("Spot + 0.5 c/kWh");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("alert").textContent).toMatch(/at least one version/);
    await user.click(screen.getByRole("button", { name: "Add version" }));
    const date = screen.getByLabelText("Valid from");
    await user.clear(date);
    await user.type(date, "2000-01-01");
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("alert").textContent).toMatch(/already starts on 2000-01-01/);
  });

  it("reloads after a concurrent save instead of overwriting it", async () => {
    const user = userEvent.setup();
    const load = vi.spyOn(api, "propertyElectricityTariff").mockResolvedValue(legacyTariff);
    vi.spyOn(api, "savePropertyElectricityTariff").mockRejectedValue(new ApiRequestError(409, "TARIFF_REVISION_CONFLICT", "changed"));
    render(<I18nProvider><ElectricityTariffPanel propertyId="property-main" readOnly={false} /></I18nProvider>);
    await screen.findByText("Spot + 0.5 c/kWh");
    await user.click(screen.getByRole("button", { name: "Add version" }));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Save tariff" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/changed elsewhere/);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("hides editing for read-only viewers", async () => {
    vi.spyOn(api, "propertyElectricityTariff").mockResolvedValue(legacyTariff);
    render(<I18nProvider><ElectricityTariffPanel propertyId="property-main" readOnly /></I18nProvider>);
    await screen.findByText("Spot + 0.5 c/kWh");
    expect(screen.queryByRole("button", { name: "Add version" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("ElectricityBillCheckPanel", () => {
  const houses = [{ id: "house-main", name: "Main home", propertyId: "property-main" }] as House[];
  const invoice = {
    id: "invoice-1", propertyId: "property-main", houseId: "house-main", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    totalEur: 50, consumptionKwh: 300, energyEur: 30, networkEur: null, taxEur: null, feesEur: null, note: null,
    createdAt: "2026-10-05T10:00:00.000Z",
  };

  it("adds an invoice and shows how it compares with the calculated cost", async () => {
    const user = userEvent.setup();
    const list = vi.spyOn(api, "electricityInvoices").mockResolvedValueOnce([]).mockResolvedValue([invoice]);
    const create = vi.spyOn(api, "createElectricityInvoice").mockResolvedValue(invoice);
    const reconciliation: ElectricityInvoiceReconciliation = {
      invoiceId: "invoice-1", status: "reconciled", tolerancePercent: 2,
      from: "2026-08-31T21:00:00.000Z", to: "2026-09-30T21:00:00.000Z",
      consumption: { invoicedKwh: 300, calculatedKwh: 298.5, errorPercent: -0.5 },
      total: { invoicedEur: 50, calculatedEur: 50.6, errorPercent: 1.2 },
      components: { energy: { invoicedEur: 30, calculatedEur: 29.4, errorPercent: -2 } },
      breakdown: null, priceCoveragePercent: 100, calculatedAt: "2026-10-05T10:00:00.000Z",
    };
    vi.spyOn(api, "reconcileElectricityInvoice").mockResolvedValue(reconciliation);
    render(<I18nProvider><ConfirmationProvider><ElectricityBillCheckPanel propertyId="property-main" houses={houses} readOnly={false} /></ConfirmationProvider></I18nProvider>);

    expect(await screen.findByText("No invoices entered yet.")).not.toBeNull();
    await user.click(screen.getByText("Add an invoice"));
    await user.type(screen.getByLabelText("First day"), "2026-09-01");
    await user.type(screen.getByLabelText("Last day"), "2026-09-30");
    await user.type(screen.getByLabelText("Invoice total (€)"), "50");
    await user.type(screen.getByLabelText("Consumption (kWh, optional)"), "300");
    await user.type(screen.getByLabelText("Energy (€, optional)"), "30");
    await user.click(screen.getByRole("button", { name: "Add invoice" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith("property-main", expect.objectContaining({
      houseId: "house-main", periodStart: "2026-09-01", periodEnd: "2026-09-30", totalEur: 50,
      consumptionKwh: 300, energyEur: 30, networkEur: null,
    })));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await user.click(await screen.findByRole("button", { name: "Check" }));
    expect(await screen.findByText("Matches within ±2%")).not.toBeNull();
    expect(screen.getByText(/Calculated €50.60, invoiced €50.00 \(\+1.2%\)/)).not.toBeNull();
    expect(screen.getByText(/Energy: calculated €29.40, invoiced €30.00 \(-2%\)/)).not.toBeNull();
    expect(screen.getByText(/Consumption: calculated 298.5, invoiced 300 kWh/)).not.toBeNull();
  });

  it("stays hidden for Guests, who cannot read invoices", async () => {
    const list = vi.spyOn(api, "electricityInvoices").mockRejectedValue(new ApiRequestError(403, "GUEST_READ_ONLY", "Guest accounts cannot access electricity invoices"));
    const view = render(<I18nProvider><ElectricityBillCheckPanel propertyId="property-main" houses={houses} readOnly /></I18nProvider>);
    await waitFor(() => expect(list).toHaveBeenCalled());
    await waitFor(() => expect(view.container.querySelector(".electricity-bill-check")).toBeNull());
  });
});
