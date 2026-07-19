# Sensor-constrained indoor flow visualization

Stuga can place the live or replayed scalar field for the selected
measurement over a shared indoor-motion estimate in both the floor plan and the
orbitable 3D building view. This layer is designed to be physically motivated,
stable, and honest about sparse home-sensor data. It is not a measured velocity
field, calibrated CFD result, ventilation-compliance calculation, or safety
instrument.

The estimate is now exposed only as an explicit **Air movement estimate** toggle
inside the experimental spatial-layer panel. It is off by default and never
feeds regular monitoring, alerts, stored measurements, or control. The 2D plan
shows a breathing-zone slice; the 3D Home view shows paths through the sampled
room volumes. The selected state persists locally, but the layer is unavailable
when the experimental engine capability is disabled.

A separate **Sensor support** toggle visualizes the current sampling constraint:
soft solid/dashed regions surround fresh temperature and paired-humidity
anchors, while plus markers identify rooms or positions where another anchor
would materially improve the estimate. In 3D those regions become projected
sampling volumes at the sensors' configured heights. This is not wireless
coverage and does not claim that space outside a region is unsafe.

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

For each coarse grid step the model applies buoyancy and supported opening or
mechanical-vent forcing, diffuses unresolved motion, and performs a pressure
projection:

```text
u* = damp_and_diffuse(u) + b ez + fwind + fvent
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
| Modelled doors and windows | Height-aware wall apertures only while their effective state is open; aperture width is scaled by the configured opening fraction |
| Open windward windows + fresh wind | Weak wind-driven circulation forcing; closed windows remain impermeable |
| Supply, extract, and balanced vents | Local qualitative forcing, scaled by optional design airflow; passive and transfer vents add topology without inventing a fan |
| Fresh Home Assistant or Tapo contact state | Overrides the configured fallback for its bound opening until the observation becomes stale |
| Outdoor pressure | Psychrometric conversion; standard pressure is the fallback |

Estimated-quality samples receive less weight. Stale samples are excluded using
the same 15-minute live and 90-minute replay windows as the spatial field.
Weather marked stale never drives wind forcing.

### Opening state and defaults

Each door, window, and vent is one shared architectural instance in the 2D and
3D editors. It can have a name, variant, width, height, bottom offset, opening
fraction, and manual state. Vents can additionally have a design airflow.
Common controls are shown first; geometry, flow, and sensor binding remain under
advanced details.

The conservative defaults are:

- doors and windows are closed;
- vents and explicit open passages are open;
- a closed element always has zero effective aperture;
- an open element uses its configured opening fraction, or 100% when omitted.

A Home Assistant entity or Tapo child-device id can be bound to an opening. A
fresh matching observation wins over the configured state. `unknown`, missing,
expired, mismatched, or stale observations fall back to the configured/manual
state, then to the architectural default. Sensor polarity can be inverted, and
the default 15-minute staleness limit can be adjusted per opening. The same
effective-dated observations are resolved against the replay timestamp, so a
historical view does not accidentally use today's door state.

Fixed windows are always closed and explicit open passages are always open;
neither accepts a contact-state binding. Provider observations carry both the
external entity/device id and their integration connection id, preventing an
old or identically named device on another hub from changing the opening.

The solver still does not infer opening state from a temperature pattern, nor
does it infer fireplace activity or occupant heat/moisture sources. A vent type
or flow must be configured; an untyped passive vent does not become a fan.

### Two-room doorway counterflow

When an open doorway separates two drawn room polygons and both rooms have fresh
temperature support, the 3D view can show the expected natural-convection
exchange explicitly: cool, denser air moves through the lower part of the
opening toward the warmer room, while warm, lighter air moves back through the
upper part toward the cooler room. The pair is omitted for a closed doorway,
unresolved room adjacency, insufficient anchors, or a negligible temperature
difference. Direction is physically motivated; its displayed speed remains
relative rather than a measured flow rate.

## Geometry and numerical bounds

Each occupied floor uses a bounded grid with 20 cells on its plan-width axis,
10–22 on the depth axis, and six vertical layers. Eight damped steady steps and
24 pressure iterations keep the work predictable. Room polygons constrain the
air mask only when they cover enough of the floor to look complete; partial
drawings do not erase the domain.

Wall crossings stop a rendered path unless the intersection lies inside the
effective width and vertical extent of an open door or window. Floors are
solved independently because the current layout schema has no stairs, shafts,
or other vertical portals. This prevents invented cross-floor transport.

The spatial topology connects openings shared by two drawn rooms internally.
A one-sided opening on a rectangular floor-perimeter wall is connected to the
same outdoor ventilation boundary used by non-transfer vents. A one-sided
opening on any other wall remains unresolved rather than being guessed as an
outdoor connection.

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
  open windward window is missing.
- A configured vent flow scales the relative preview; without a physical plan
  scale, pressure data, and commissioning measurements it is not a verified
  volume flow or ventilation-compliance result.
- Contact sensors report state, not aperture geometry. Opening fraction remains
  configured unless a richer observation explicitly supplies it.
- Uniform conditions in a closed floor decay to no displayed motion; the UI does
  not add decorative ambient flow.
- CO2, VOC, and particles are transported tracers. Their concentration does not
  meaningfully push room air and must not be used as a direct force.

The next scientifically meaningful additions are supply-air temperature and
moisture, pressure/commissioning data, a reliable horizontal plan scale, and
explicit stairs, shafts, and other vertical portals. Those inputs can later
feed a conservative multizone airflow network and calibrated advection model.

The view turns those limitations into calm, scoped suggestions. It may recommend
a second fresh temperature/humidity anchor on a floor, a sensor nearer the
centre of an unobserved room at breathing height, restoration of a stale sensor,
fresh outdoor pressure, modelled openings, a physical plan scale, or explicit
vertical portals. Recommendations improve model support; they are not safety or
compliance requirements.

## References

- Jos Stam, [Real-Time Fluid Dynamics for Games](https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/GDC03.pdf), for the stable grid, diffusion, and pressure-projection approach.
- NIST, [CONTAM documentation](https://www.nist.gov/el/beed/nist-multizone-modeling/software/contam/contam-documentation), for the multizone/opening-network direction appropriate to future building-scale forcing.
- NOAA/COAPS, [Air-Sea Fluxes handbook](https://downloads.psl.noaa.gov/BLO/Air-Sea/wcrp_wgsf/flux_handbook/Constants_functions_ELA_05.pdf), for humidity and vapour-pressure relationships.
