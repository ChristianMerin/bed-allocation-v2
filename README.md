# Bed Allocation & Inpatient Ward Management

A subsystem of the Hospital Management System (HMS) that manages wards, beds (**Private**, **Semi-Private**, **Ward**), and inpatient admissions, transfers and discharges.

**Stack:** Node.js 20+, Express 5, Mongoose 9, MongoDB Atlas. A staff dashboard in plain HTML/JS is included.

---

## 1. Setup

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
# edit .env -> MONGODB_URI, DB_NAME, API_KEY
npm run seed                # 7 specialty wards, 86 beds
npm run dev                 # http://localhost:5000
```

### MongoDB Atlas checklist
1. Create a cluster (the free M0 tier works). Atlas clusters are replica sets, which this service **needs** because admissions use transactions.
2. **Database Access**: create a DB user with readWrite on your HMS database.
3. **Network Access**: add your server's IP (or `0.0.0.0/0` for development only).
4. **Connect > Drivers**: copy the `mongodb+srv://...` string into `MONGODB_URI`.
5. Databases on the integrated cluster:
   - **`bed_allocation`** (`DB_NAME`) is this subsystem's own database, holding `ipd_wards`, `ipd_beds`, `ipd_admissions`, `ipd_room_rates`, `ipd_price_history`, `ipd_bed_activity`, `ipd_counters`, `ipd_users` and `ipd_sessions`.
   - **`medilink_lab_dev`** (`PATIENT_DB`) is the shared HMS database. Patients are **read** from `admit_patients` (`PATIENT_COLLECTION`), which belongs to Patient Registration. Only ID, name, sex, birth date and contact number are read.
   - `LEGACY_DB`: on first start, our earlier `ipd_*` data is copied once from that database into `bed_allocation`, while `bed_allocation` is still empty. The source is never changed.

---

## 2. Project structure

```
src/
  config/       env, db connection, domain constants (categories, statuses, rules)
  models/       Ward, Bed, Admission, BedActivity (audit), Counter
  services/     allocationService (admit/transfer/discharge), bedService, dashboardService
  routes/       REST endpoints (one router = whole module)
  middleware/   API-key auth, actor (audit user), error handler
  utils/        billing (room charges), transactions, AppError
  seed/         sample data
  app.js        express app      server.js  entry point + reservation-expiry job
public/         staff dashboard (Bed Board, Admissions, Setup)
```

---

## 3. Business rules

**Ward = specialty, category = room class.** Each specialty has its own ward (Medical, Surgical, Orthopedic, Pediatric, Maternity/OB-Gyne, ICU, Isolation). Inside a ward are rooms of the three classes, Private, Semi-Private and Ward (open bay), so an orthopedic patient can be admitted to an Orthopedic private room or an Orthopedic open-bay bed.

| Rule | Where |
|---|---|
| Room capacity: Private = 1 bed, Semi-Private = 2 beds, Ward = up to 12 beds per room | `CATEGORY_RULES` in constants |
| All beds in a room share one category | `bedService.createBeds` |
| A bed can never be given to two patients, even with simultaneous requests | atomic `findOneAndUpdate` with a status condition, inside a transaction |
| One active admission per patient | partial unique index on `ipd_admissions` |
| Ward gender policy (male / female / mixed) | `allocationService` |
| Shared rooms (semi-private and open bays) never mix genders; the room takes the gender of its first patient. Pediatric wards are exempt | `roomAcceptsGender` |
| Bed lifecycle: available → occupied → **cleaning** → available. Maintenance takes a bed out of service | `MANUAL_STATUS_TRANSITIONS` |
| Reservations expire automatically (job runs every minute) | `releaseExpiredReservations` |
| Room charges use the rate in effect when the patient entered the bed; stays under 4h before a transfer are free | `utils/billing.js` |
| Every bed change is logged with who did it | `ipd_bed_activity` |

---

## 4. API (base: `/api/v1`)

### Login and access
Every endpoint except `/auth/login` needs **one** of these:
- **A logged-in user.** The dashboard uses an httpOnly cookie. Other apps call `POST /auth/login` and send the returned token as `Authorization: Bearer <token>`.
- **The HMS server key** `x-api-key: <API_KEY>`, but only if `API_KEY` is set in `.env`. The calling server names the person with `x-user-id`, `x-user-name` and `x-user-role`.

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{ username, password }` returns `{ user, token, expiresAt }` and sets the cookie. Locked for 15 minutes after 5 failed attempts |
| POST | `/auth/logout` | ends the session |
| GET | `/auth/me` | the current user |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` |
| GET/POST/PATCH | `/users`, `/users/:id` | admin only: list or create users; edit name/role, deactivate, reset password |

**Roles.** `admin` can do everything. `staff` can read everything; admit, transfer and discharge patients; and change bed status and reservations. Changes to wards, rooms, rates, beds and users are admin only (`403` for staff).
The first admin account is created at the first start from `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`.

### Wards
| Method | Path | Notes |
|---|---|---|
| GET | `/wards` | with live bed counts |
| GET | `/wards/:id` | |
| POST | `/wards` | `{ code, name, type, floor, genderPolicy, headNurse:{staffId,name} }` |
| PATCH | `/wards/:id` | |
| DELETE | `/wards/:id` | soft delete; blocked if any bed is occupied |

### Beds
| Method | Path | Notes |
|---|---|---|
| GET | `/beds?wardId=&category=&status=` | status may be a list: `available,reserved` |
| GET | `/beds/available?category=&gender=&wardId=` | beds you can give a patient, plus a count per category |
| GET | `/beds/:id` · `/beds/:id/activity` | |
| POST | `/beds` | `{ wardId, roomNumber, category, count, dailyRate?, features? }`; bed numbers auto-generated as `PVT-301-A` |
| PATCH | `/beds/:id` | dailyRate, features, statusNote |
| PATCH | `/beds/:id/status` | `{ status: available \| cleaning \| maintenance, note }` |
| POST | `/beds/:id/reserve` | `{ patientId, patientName, reason, reservedUntil }` |
| POST | `/beds/:id/release` | |
| DELETE | `/beds/:id` | soft delete; blocked if occupied |

### Rooms
A room is the set of beds sharing a ward and room number. All of its beds have the same class.

| Method | Path | Notes |
|---|---|---|
| GET | `/rooms?wardId=&category=` | rooms with bed counts, status, price, and whether the price is custom |
| POST | `/rooms` | `{ wardId, roomNumber, category, beds, dailyRate?, features? }`. If `dailyRate` is left out, the rate card price is used |
| POST | `/rooms/:wardId/:roomNumber/beds` | `{ count }`; new beds copy the room's price and features |
| PATCH | `/rooms/:wardId/:roomNumber` | `{ dailyRate?, useRateCard?, features?, category?, note? }`. Class can only change when the room is empty |
| DELETE | `/rooms/:wardId/:roomNumber` | soft delete; blocked if any bed is occupied or reserved |

### Room rates (pricing)
Prices are resolved in this order: **room custom price**, then **ward rate**, then **hospital default**. A running bill always keeps the price in effect at admission or transfer.

| Method | Path | Notes |
|---|---|---|
| GET | `/rates` | rate card: hospital defaults plus every ward × class (with bed counts and custom-priced beds) |
| PUT | `/rates` | `{ wardId?, category, dailyRate, applyToExisting?, note? }`. Leave `wardId` empty to set the hospital default |
| DELETE | `/rates/:id?applyToExisting=true` | remove a ward rate so the ward falls back to the hospital default |
| GET | `/rates/history` | audit log of every price change |

### Admissions
| Method | Path | Notes |
|---|---|---|
| POST | `/admissions` | admit (example below) |
| GET | `/admissions?status=admitted&search=&page=&limit=` | |
| GET | `/admissions/:id` | |
| GET | `/admissions/patient/:patientId` | active admission + history for the HMS patient chart |
| POST | `/admissions/:id/transfer` | `{ bedId }` or `{ category, wardId? }`, plus `reason` |
| POST | `/admissions/:id/discharge` | `{ dischargeType, summary, dischargedBy }`; returns final room charges |
| GET | `/admissions/:id/charges` | running or final room charges for Billing |

```json
POST /api/v1/admissions
{
  "patient": { "patientId": "PT-2026-00123", "name": "Maria Santos", "gender": "female" },
  "category": "semi-private",
  "admissionType": "emergency",
  "admittingDoctor": { "doctorId": "DOC-014", "name": "Dr. Reyes" },
  "diagnosis": "Community-acquired pneumonia"
}
```
Send `bedId` instead of `category` to pick an exact bed.

### Other
`GET /dashboard/summary` (occupancy by category and ward, admissions and discharges today, average length of stay) · `GET /meta` (enums) · `GET /health` (no key needed)

Errors are always returned as `{ success:false, message, details? }`, with status 400 (bad input), 401, 404, 409 (conflict, e.g. bed taken) or 422 (breaks a rule, e.g. gender policy).

---

## 5. Integrating with the main HMS

**Option A: separate microservice (recommended).** Run this service on its own port. The main HMS calls it over HTTP with `x-api-key`, passing the logged-in user in `x-user-*` headers.

**Option B: mount inside the main Express app.** Both apps share one mongoose connection:
```js
// in the main HMS (Express 5)
require('./bed-allocation/src/models');
app.use('/api/ipd', require('./bed-allocation/src/routes'));
// start the reservation sweep once:
setInterval(() => require('./bed-allocation/src/services/bedService').releaseExpiredReservations(), 60000);
```

**Data ownership:** patients, doctors and staff belong to the main HMS. This module stores only their IDs plus a name snapshot (`patient.patientId`, `admittingDoctor.doctorId`, `headNurse.staffId`).
