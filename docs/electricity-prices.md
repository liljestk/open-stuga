# Electricity prices and contracts

Electricity prices belong to a Property, while consumption meters belong to a
Home. This lets one Stuga installation model Properties with different
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

Stuga stores the returned value unchanged as `rawPriceCentsPerKwh`. The effective
price is derived when reading it:

```text
effectivePriceCentsPerKwh = rawPriceCentsPerKwh + marginCentsPerKwh
effectivePriceEurPerKwh   = effectivePriceCentsPerKwh / 100
```

Changing a margin therefore never rewrites or rounds the upstream history.
Contract metadata includes type, retailer, contract name, and optional monthly
fee. The monthly fee is descriptive and is not folded into instantaneous €/h
cost because doing so would require an arbitrary allocation policy.

Saving descriptive fields preserves the existing `contractType` and `enabled`
state. Fixed, other, and disabled contracts are never converted to an enabled
spot contract as a side effect of editing their name, retailer, margin, or fee.

Custom HTTPS sources are supported when they return the same JSON shape as the
Pörssisähkö `prices` response.

## REST API

```text
GET  /api/v1/properties/{propertyId}/electricity
PUT  /api/v1/properties/{propertyId}/electricity/config
POST /api/v1/properties/{propertyId}/electricity/refresh
```

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
Stuga sensor so identical device IDs on different local hosts remain distinct.

```text
GET /api/v1/integrations/tp-link/devices?houseId={houseId}
```

TP-Link contributes `power` and, when the device exposes a cumulative total,
`energy`. It never supplies the electricity price; the property price service is
the authoritative source used for cost estimates.

Home meter and consumption detail remains available from the selected Home.
The permanent navigation item **Electricity** is Property-scoped so a Property
without any Home can still manage its contract and price source.
