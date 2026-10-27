const propertyId = { $ref: "#/components/parameters/Id" } as const;
const invoiceId = { name: "invoiceId", in: "path", required: true, schema: { type: "string", maxLength: 200 } } as const;
const tariffResponse = {
  description: "The Property tariff and the time zone its local dates and schedules use",
  content: { "application/json": { schema: {
    type: "object", additionalProperties: false, required: ["tariff", "timeZone"],
    properties: { tariff: { $ref: "#/components/schemas/PropertyElectricityTariff" }, timeZone: { type: "string" } },
  } } },
} as const;
const guestForbidden = { description: "Guest accounts cannot read invoices" } as const;

/** Dated tariff versions and invoice reconciliation for a Property's electricity contract. */
export const electricityTariffPaths = {
  "/properties/{id}/electricity/tariff": {
    get: {
      tags: ["Energy"], operationId: "getPropertyElectricityTariff", parameters: [propertyId],
      responses: { "200": tariffResponse, "404": { $ref: "#/components/responses/NotFound" } },
    },
    put: {
      tags: ["Energy"], operationId: "savePropertyElectricityTariff", parameters: [propertyId],
      description: "Replaces every tariff version. Costs and effective prices are recalculated from raw spot prices with the new versions.",
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ElectricityTariffInput" } } } },
      responses: {
        "200": tariffResponse,
        "400": { description: "Invalid tariff versions" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "The stored revision differs from the one sent" },
      },
    },
  },
  "/properties/{id}/electricity/invoices": {
    get: {
      tags: ["Energy"], operationId: "listElectricityInvoices", parameters: [propertyId],
      responses: {
        "200": { description: "Manually entered invoices of visible Homes, newest period first", content: { "application/json": { schema: {
          type: "object", additionalProperties: false, required: ["invoices"],
          properties: { invoices: { type: "array", items: { $ref: "#/components/schemas/ElectricityInvoice" } } },
        } } } },
        "403": guestForbidden,
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    post: {
      tags: ["Energy"], operationId: "createElectricityInvoice", parameters: [propertyId],
      requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/ElectricityInvoiceInput" } } } },
      responses: {
        "201": { description: "Stored invoice", content: { "application/json": { schema: {
          type: "object", additionalProperties: false, required: ["invoice"],
          properties: { invoice: { $ref: "#/components/schemas/ElectricityInvoice" } },
        } } } },
        "400": { description: "Invalid invoice" },
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "Invoice limit reached" },
      },
    },
  },
  "/properties/{id}/electricity/invoices/{invoiceId}": {
    delete: {
      tags: ["Energy"], operationId: "deleteElectricityInvoice", parameters: [propertyId, invoiceId],
      responses: {
        "200": { description: "Deleted invoice", content: { "application/json": { schema: {
          type: "object", additionalProperties: false, required: ["deleted", "invoiceId"],
          properties: { deleted: { const: true }, invoiceId: { type: "string" } },
        } } } },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
  "/properties/{id}/electricity/invoices/{invoiceId}/reconciliation": {
    get: {
      tags: ["Energy"], operationId: "reconcileElectricityInvoice", parameters: [propertyId, invoiceId],
      description: "Calculates the Home summary for the invoice's local billing dates under the tariff in force and compares total and components. The status uses the total only.",
      responses: {
        "200": { description: "Calculated and invoiced amounts with percentage errors", content: { "application/json": { schema: {
          type: "object", additionalProperties: false, required: ["reconciliation"],
          properties: { reconciliation: { $ref: "#/components/schemas/ElectricityInvoiceReconciliation" } },
        } } } },
        "403": guestForbidden,
        "404": { $ref: "#/components/responses/NotFound" },
        "409": { description: "The billing period cannot be resolved in the Home's time zone" },
        "503": { description: "History or rollups are still being prepared; retry later" },
      },
    },
  },
};
