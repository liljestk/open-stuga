# Electricity prices and contracts

Electricity prices belong to a Property, while consumption meters belong to a
Home. This lets one Stugu installation model Properties with different
retailers, margins, or price feeds and Homes with one or several Tapo meter
devices.

## Default source

Every property receives an enabled `porssisahko` configuration automatically:

```text
https://api.porssisahko.net/v2/latest-prices.json
```

The service fetches this feed at startup and every 12 hours. A manual refresh is
available from **Property → Electricity** at
`/properties/{propertyId}/electricity` and from the REST API. Pörssisähkö v2 publishes up to
192 quarter-hour intervals. Its `price` value is cents/kWh including the VAT that
applied on that date; `startDate` and `endDate` are UTC timestamps.

Stugu stores the returned value unchanged as `rawPriceCentsPerKwh`. Every
effective price and every cost is derived from it when reading, under the
Property's tariff.

Every successful fetch first commits all source intervals to the crash-safe
SQLite outbox and immediately wakes TimeDB reconciliation. The permanent store
keeps the interval boundaries, raw price, a margin snapshot, and fetch time in
the TimescaleDB `electricity_price_samples` hypertable. Repeated fetches are
idempotent, and raw archive rows have no expiry policy. Historical API reads
merge the SQLite current/unacknowledged tail with TimescaleDB, so daily,
weekly, monthly, yearly, and later calendar-period analytics use durable price
history rather than only the latest provider response. The margin snapshot is
kept for audit only; prices and costs never use it.

## Tariff

A Property's contract is a list of dated **tariff versions**. Each version
applies from its `validFrom` local date until the next version; the earliest
version also covers every earlier date. Dates and schedules use the time zone of
the Home being costed (for Property-wide prices, its default Home's). All rates
include VAT, as on a consumer invoice.

| Part | Options |
| --- | --- |
| Energy | Spot (raw feed + margin, c/kWh), fixed price with a flat, day/night or seasonal schedule, or not entered yet |
| Transfer | None, or a flat, day/night or seasonal charge (c/kWh) |
| Electricity tax | Optional c/kWh |
| Monthly fees | Optional retailer and network fees (€/month) |

Day/night schedules treat 07:00–22:00 local time as daytime. Seasonal schedules
charge the winter rate on November–March, Monday–Saturday, 07:00–22:00 local
time, and the other rate at all other times.

```text
effectivePriceCentsPerKwh = energy + transfer + tax   (for the interval's version)
energy (spot)             = rawPriceCentsPerKwh + marginCentsPerKwh
```

While a fixed contract's energy price is not entered, effective prices fall back
to the raw spot price and costs report the energy price as missing instead of
pricing the contract at spot.

Costs are calculated per UTC hour from metered usage: spot energy uses the raw
price of the intervals the usage falls in; fixed energy, transfer and tax use the
rate in force for that local hour. Transfer and tax are charged on the same kWh
as energy, so a partly priced period stays a consistent "priced so far" figure.
Monthly fees are pro-rated by local calendar day (fee ÷ days in that month, a
25-hour or 23-hour day counting as one day) and are added once per Home
summary, as `totalCostEur`. Summaries return the split as `costBreakdown`, with
the components they include.

Properties upgraded from before 0.43 start with one open-ended version built
from the earlier contract fields: spot and "other" contracts keep their margin,
and a fixed contract has no energy price until one is entered. Until dated
versions are saved, a margin change applies to the whole history. The older
`marginCentsPerKwh`, `contractType` and `monthlyFeeEur` configuration fields
still work: they show, and update, the version in force today.

## Bill check

Invoices are entered by hand (billing dates, total, and optionally kWh and the
energy, transfer, tax and fee lines). A reconciliation calculates the Home
summary for the invoice's local billing dates and reports the error of the total
and of each entered line. The status uses the total: within ±2% counts as
reconciled.

Custom HTTPS sources are supported when they return the same JSON shape as the
Pörssisähkö `prices` response.

## REST API

```text
GET    /api/v1/properties/{propertyId}/electricity
PUT    /api/v1/properties/{propertyId}/electricity/config
POST   /api/v1/properties/{propertyId}/electricity/refresh
GET    /api/v1/properties/{propertyId}/electricity/tariff
PUT    /api/v1/properties/{propertyId}/electricity/tariff
GET    /api/v1/properties/{propertyId}/electricity/invoices
POST   /api/v1/properties/{propertyId}/electricity/invoices
DELETE /api/v1/properties/{propertyId}/electricity/invoices/{invoiceId}
GET    /api/v1/properties/{propertyId}/electricity/invoices/{invoiceId}/reconciliation
```

`PUT …/tariff` replaces every version and accepts the loaded `revision` to
reject a concurrent edit with 409. Invoices and reconciliations are not shown to
Guests.

The GET response contains `config`, `current`, and `prices`. Each price point
contains both raw and effective values so consumers never have to guess which
one they received.

These endpoints expose a Property aggregate. A Guest needs a direct grant for
that Property; a child Home or Area grant reveals only the minimal parent shell
and does not reveal contract metadata or the Property price history.

## Tapo meters

Direct TP-Link connections are Home-scoped. Saving a connection requires the
owning `houseId`; the server can run several local helpers at once and one helper
may expose several energy endpoints. Discovered devices include `houseId` and
`connectionId`. Persist both `tpLinkDeviceId` and `tpLinkConnectionId` on the
Stugu sensor so identical device IDs on different local hosts remain distinct.

```text
GET /api/v1/integrations/tp-link/devices?houseId={houseId}
```

TP-Link contributes `power` and, when the device exposes a cumulative total,
`energy`. It never supplies the electricity price; the property price service is
the authoritative source used for cost estimates.

Home meter and consumption detail remains available from the selected Home.
The permanent navigation item **Electricity** is Property-scoped so a Property
without any Home can still manage its contract and price source.
