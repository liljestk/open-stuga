# Sensor-constrained indoor flow visualization

Stuga can place the live or replayed scalar field for the selected
measurement over a shared indoor-motion estimate in both the floor plan and the
orbitable 3D building view. This layer is designed to be physically motivated,
stable, and honest about sparse home-sensor data. It is not a measured velocity
field, calibrated CFD result, ventilation-compliance calculation, or safety
instrument.

## What the views show

- The coloured clouds remain the independently estimated field for the selected
  measurement: temperature, relative humidity, CO2, or another spatial metric.
- Curved teal paths come from one shared velocity estimate. Changing the selected
  metric recolours the scalar field but does not change flow direction.
- The 2D plan is a breathing-zone slice of the same per-floor volume used by the
  3D paths. Up/down glyphs expose the vertical component that the plan cannot
  otherwise show.
- Path animation communicates direction only. Its duration is deliberately
  fixed and does not claim a speed in metres per second.
- When the coupled model lacks two fresh temperature anchors on a floor, the UI
  falls back to the existing high-to-low scalar-gradient cue and labels it as a
  gradient rather than airflow.

## Governing approximation

The browser solves a coarse, steady, Boussinesq-inspired relative velocity
field. Temperature and paired relative humidity are first converted to a
virtual-temperature buoyancy term:

```text
e  = RH / 100 × saturation_vapour_pressure(T)
w  = 0.62198 e / (p - e)
q  = w / (1 + w)
Tv = (T + 273.15) × (1 + 0.61 q)
b  = g × (Tv - Tv_ref) / Tv_ref
```

Fresh outdoor pressure is used when available; otherwise standard pressure
1013.25 hPa is an explicit assumption. Relative humidity itself is not treated
as a conserved scalar.

For each coarse grid step the model applies buoyancy and any supported wind
leakage forcing, diffuses unresolved motion, and performs a pressure projection:

```text
u* = damp_and_diffuse(u) + b ez + fwind
∇²p = ∇·u*
u = u* - ∇p
```

The projection reduces divergence so the result behaves like an incompressible
circulation rather than arrows down a temperature or humidity gradient. The
current implementation computes a normalized relative field, not physical
travel time or flow rate. It intentionally stops short of claiming a full
Navier–Stokes/CFD solution.

## How available data is used

| Input | Role |
| --- | --- |
| Fresh indoor temperature | Scalar anchor and principal buoyancy input |
| Fresh RH paired with temperature | Converted to specific humidity and included in virtual temperature |
| CO2 | Passive tracer used to favour informative streamline seeds; never a body force |
| Sensor x/y/z and quality | Field anchors, vertical placement, and data-support weighting |
| Walls | Impermeable velocity faces and a strong penalty in scalar interpolation |
| Modelled doors | Permeable gaps in referenced walls; door symbols are assumed open because no open/closed state exists yet |
| Modelled windward windows + fresh wind | Weak wind-leakage circulation forcing |
| Outdoor pressure | Psychrometric conversion; standard pressure is the fallback |

Estimated-quality samples receive less weight. Stale samples are excluded using
the same 15-minute live and 90-minute replay windows as the spatial field.
Weather marked stale never drives wind forcing.

The solver does not infer that a window is open, that a vent is supply or
extract, that a fireplace is active, or that a person caused a heat/moisture
source. Those states do not exist in the current contract. A window symbol is
used only as a conservative leakage location when current oriented wind is
available. A door symbol is explicitly treated as an always-open gap until the
layout schema can store opening state.

## Geometry and numerical bounds

Each occupied floor uses a bounded grid with 20 cells on its plan-width axis,
10–22 on the depth axis, and six vertical layers. Eight damped steady steps and
24 pressure iterations keep the work predictable. Room polygons constrain the
air mask only when they cover enough of the floor to look complete; partial
drawings do not erase the domain.

Wall crossings stop a rendered path unless the intersection lies inside a
modelled door opening. Floors are solved independently because the current
layout schema has no stairs, shafts, or other vertical portals. This prevents
invented cross-floor transport.

Plan width and depth use local drawing coordinates, while only elevation and
sensor z are guaranteed to be metres. The solver therefore normalizes each
floor and reports relative motion. A future physical-speed mode requires an
explicit horizontal scale plus measured/configured opening and fan flow data.

## Interpretation limits

- Two or three room sensors cannot resolve jets, boundary layers, turbulence,
  wake flow, or short-lived door motion.
- Interpolated temperature and moisture can miss local sources between sensors.
- A pressure projection improves mass-conservation behaviour but does not make
  unmeasured boundary conditions known.
- Wind forcing is omitted when orientation, current wind, or a plausible
  windward window is missing.
- Uniform conditions in a closed floor decay to no displayed motion; the UI does
  not add decorative ambient flow.
- CO2, VOC, and particles are transported tracers. Their concentration does not
  meaningfully push room air and must not be used as a direct force.

The next scientifically meaningful schema additions are opening state/effective
area, vent mode and flow rate, supply-air temperature/moisture, horizontal plan
scale, and explicit stairs/shafts. Those inputs can later feed a conservative
multizone airflow network and calibrated advection model.

## References

- Jos Stam, [Real-Time Fluid Dynamics for Games](https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/GDC03.pdf), for the stable grid, diffusion, and pressure-projection approach.
- NIST, [CONTAM documentation](https://www.nist.gov/el/beed/nist-multizone-modeling/software/contam/contam-documentation), for the multizone/opening-network direction appropriate to future building-scale forcing.
- NOAA/COAPS, [Air-Sea Fluxes handbook](https://downloads.psl.noaa.gov/BLO/Air-Sea/wcrp_wgsf/flux_handbook/Constants_functions_ELA_05.pdf), for humidity and vapour-pressure relationships.
