# Effective room thermal simulation

Stuga 0.2.0 adds an experimental, sensor-scoped first-order thermal
model. Its purpose is to compare measured indoor temperature with a transparent
weather-response baseline and make the unexplained residual visible. It is not
CFD, an EnergyPlus replacement, or a method for deriving physical wall values.

## Model

The engine uses the exact discrete form of:

```text
dTin/dt = (Tout + L - Tin) / tau
```

- `tau` is an **effective thermal time constant**.
- `L` is an **effective equilibrium lift** combining average HVAC, occupants,
  appliances, and solar gains that were not measured independently.
- `residual = observed - simulated`.

Both fitted values describe the dataset and model assumptions. They are not a
wall U-value, air-change rate, material heat capacity, leakage measurement, or
HVAC efficiency.

## Data and readiness

Fresh FMI temperature observations requested for a house are stored in a
separate `outdoor_temperature_samples` boundary table. They are keyed by the
house location using an opaque digest so moving the house cannot mix
observations from two places. Changing or clearing the location deletes the
old boundary rows, and normal telemetry retention applies to them.
Forecasts and stale cache fallbacks are not stored as observations. Outdoor
boundaries never enter the indoor measurement registry.

Calibration requires at least 48 usable indoor/outdoor transitions and 24
hours of overlap. Seven days is the minimum window for a result to graduate
from provisional solely on duration. The engine:

- uses canonical temperature samples, excluding stale and replay data;
- quality-weights and aggregates dense input into five-minute UTC buckets in
  SQLite before fitting, bounding synchronous work and chart output;
- linearly aligns timestamped outdoor observations only across gaps of at most
  two hours;
- selects the longest continuous usable span, so disconnected fragments cannot
  fake the 24-hour readiness gate;
- accepts irregular canonical intervals from five minutes to two hours;
- uses chronological training/tuning/untouched-validation partitions and
  robust fitting;
- compares validation error with a persistence baseline;
- reports weak parameter identification and out-of-range scenarios.

Until the gates are met, the endpoint returns an `insufficient-data` result
with counts and reason codes. It never substitutes the current outdoor value
for missing historical weather. The bundled demo includes a separately marked
`mock` outdoor series so the workflow can be evaluated without waiting.

## API and UI

```http
GET /api/v1/houses/{houseId}/thermal-simulation
    ?sensorId={sensorId}
    &from={ISO timestamp}
    &to={ISO timestamp}
    &horizonHours=12
    &scenarioOutdoorTemperatureC=-10
```

The API defaults to seven days and caps one synchronous calibration request at
14 days. Five-minute database aggregation and a 5,000-bucket fit/output budget
keep dense local telemetry from turning one request into unbounded CPU or JSON.

The optional scenario changes only the future outdoor boundary. Without
measured HVAC state, the model must not claim to simulate heating-off, setpoint,
window, or ventilation interventions.

The Twin renders four distinct concepts:

- observed temperature;
- simulated temperature;
- an empirical model band;
- a separate signed residual plot.

Simulated points are computed on demand and are never written to measurement
history. The historical line is an in-sample fitted reconstruction, not a
holdout backtest; the reported validation metrics use the untouched final time
partition. A scenario beyond the calibrated outdoor envelope or longer than 48
hours is explicitly marked provisional. If the latest aligned observation is
more than two hours before the requested scenario start, the API reports a
stale-anchor warning and withholds future points.

## Path to higher fidelity

The next useful inputs are durable HVAC state/energy, window and door state,
stable room identifiers, room volume, and typed envelope/opening topology. A
multizone airflow engine such as CONTAM or Modelica belongs behind a separate
adapter after those boundary conditions exist. CFD remains an offline expert
workflow until detailed geometry, diffuser flows, surface temperatures, and
validation measurements are available.
