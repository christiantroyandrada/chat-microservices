# Third-Party Notices — chat-microservices (Backend)

This project is licensed under the MIT License.  
See [LICENSE](./LICENSE) for the full license text.

This file documents all third-party open-source packages used across the backend
microservices (`user-service`, `chat-service`, `notification-service`) that require
attribution or special notice, particularly those with copyleft or dual-license terms.

---

## License Compliance Scan Summary

| Service | Scan Date | Issues Found | Status |
|---|---|---|---|
| `user-service` | 2026-03-02 | None | ✅ Clean |
| `chat-service` | 2026-03-02 | None | ✅ Clean |
| `notification-service` | 2026-03-02 | 1 — dual-license (see §1) | ✅ Elected BSD-3-Clause |

---

## §1 — Dual-Licensed Dependency (notification-service)

### `node-forge@1.3.3`

- **License offered:** `(BSD-3-Clause OR GPL-2.0)`
- **Repository:** https://github.com/digitalbazaar/forge
- **Used in:** `notification-service` (transitive dependency via `firebase-admin`)

**License election:**  
This project elects to use `node-forge` under the **BSD-3-Clause** license.  
The full BSD-3-Clause license text is available at:  
https://opensource.org/license/bsd-3-clause

---

## §2 — All Other Third-Party Packages

All remaining production dependencies across all three backend services use fully
permissive licenses compatible with the MIT license of this project.

| License | Notes |
|---|---|
| MIT | Most widely used permissive license |
| ISC | Functionally equivalent to MIT/BSD-2-Clause |
| Apache-2.0 | Permissive; includes explicit patent grant |
| BSD-2-Clause | Permissive; minimal restrictions |
| BSD-3-Clause | Permissive; adds non-endorsement clause |
| 0BSD | No attribution required; based on ISC license (not BSD family per OSI) |
| BlueOak-1.0.0 | Permissive; modern clarity-focused license |
| MIT-0 | MIT with no attribution requirement |

No LGPL, AGPL, SSPL, CC-BY-SA, or other copyleft licenses were detected in any
backend service, with the exception of `node-forge` which offers GPL-2.0 as one
option of its dual license — BSD-3-Clause was elected for this project (see §1).

---

## Regenerating This Scan

```bash
# Run from each service directory
cd user-service && npx license-checker --production --summary
cd chat-service && npx license-checker --production --summary
cd notification-service && npx license-checker --production --summary

# Full JSON output per service
npx license-checker --production --json > licenses.json
```
