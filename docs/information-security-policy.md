# Shipo LLC — Information Security, Risk Assessment & Incident Response Policy

**Company:** Shipo LLC
**Address:** 310 Cornell Dr, Wilmington, DE 19801
**Policy owner:** Ophir Schultz (Owner / Principal)
**Effective date:** 2026-08-10
**Review cadence:** Reviewed at least annually, and after any material change to systems, staffing, or a security incident.
**Version:** 1.0

---

## 1. Purpose & Scope

This policy defines how Shipo LLC protects the confidentiality, integrity, and availability of the data we handle — including client business information, inventory and order data, and any Amazon-originated data we process to provide third-party logistics (3PL) and fulfillment services.

It applies to all Shipo LLC owners, employees, contractors, and any third-party service providers who access Shipo systems or data.

---

## 2. Data We Handle

- **Client data:** contact details, inventory records, SKUs, and shipment/order data provided by our clients.
- **Amazon-related data:** order, product, and shipment information received **only** from our clients or authorized Amazon systems for the purpose of fulfilling their orders. We do **not** gather Amazon customer, product, or business information from non-Amazon third-party sources.
- **Operational data:** billing records, carrier/shipping data, and internal fulfillment records.

We do **not** sell, rent, or share individual or combined client data with other customers, partner companies, or outside organizations, except as strictly required to deliver the service the client has engaged us for (e.g., carriers, ShipStation) or as required by law.

---

## 3. Access Control

- Access to systems and data is granted on a **least-privilege, need-to-know** basis.
- Each user has a unique account; **credentials are never shared**.
- Multi-factor authentication (MFA) is enabled on all critical systems where available (email, cloud infrastructure, Supabase, Vercel, GitHub, Amazon Seller/SPN portals).
- Administrative credentials and API keys are stored in a password manager or secure secrets store — **never** in plain text, email, chat, or source code.
- Access is reviewed periodically and **revoked promptly** when a person leaves or no longer needs it.

---

## 4. Data Protection

- Data in transit is protected using **TLS/HTTPS**.
- Data at rest is protected by the encryption provided by our cloud platforms (Supabase/PostgreSQL, Vercel).
- Row-Level Security (RLS) is enabled on database tables to restrict data access.
- Backups of critical data are maintained by our managed database provider, with point-in-time recovery available.
- Production secrets (API keys, passwords, tokens) are managed via environment variables / secrets managers, not committed to code repositories.

---

## 5. Risk Assessment Process

Shipo LLC performs a documented risk assessment on a recurring basis:

1. **Inventory** the systems, data, and third-party services in use.
2. **Identify threats** to each (unauthorized access, credential compromise, data loss, vendor breach, service outage, phishing/social engineering).
3. **Assess** each risk by likelihood and impact.
4. **Mitigate** — apply controls (MFA, least-privilege, encryption, monitoring, vendor vetting) to bring risk to an acceptable level.
5. **Document & review** — record findings and re-assess at least annually and after any significant change or incident.

New vendors and integrations are reviewed for their security posture before being granted access to Shipo data.

---

## 6. Monitoring & Detection

- Access logs and system logs from our cloud platforms (Supabase, Vercel, GitHub) are available and reviewed when anomalies are suspected.
- Failed login attempts, unexpected access patterns, and platform security alerts are monitored.
- Staff are instructed to report anything suspicious (phishing emails, unexpected access requests, unusual system behavior) immediately.

---

## 7. Incident Response Plan

If a security incident is suspected or confirmed, Shipo LLC follows these steps:

1. **Identify & Report** — Anyone who detects a potential incident notifies the Policy Owner (Ophir Schultz) **immediately**.
2. **Contain** — Limit the damage: disable affected accounts, rotate compromised credentials, isolate affected systems.
3. **Assess** — Determine what data/systems were affected, the scope, and the cause.
4. **Eradicate & Recover** — Remove the threat, restore from clean backups if needed, and verify systems are secure before returning to normal operation.
5. **Notify** — Notify affected clients, and any partners or authorities, as required by contract and applicable law, without undue delay. **Any security incident involving Amazon information is reported to Amazon at security@amazon.com within 24 hours of confirming the incident.**
6. **Review** — After resolution, conduct a post-incident review to document the root cause and update controls and this policy to prevent recurrence.

**Primary incident contact:** Ophir Schultz — ophir@shipousa.com / ophir@getshipo.com — 302-442-2343.

---

## 8. Credential Hygiene

- Passwords are strong, unique, and stored in a password manager.
- Credentials are **rotated** immediately if exposure is suspected.
- Credentials are never transmitted in plain text over email or chat.

---

## 9. Notifying Amazon of Organizational Changes

Shipo LLC maintains a policy to **notify Amazon within 30 days** of material organizational changes, including changes to legal entity, ownership, primary contacts, or business address, in accordance with Amazon's program requirements.

---

## 10. Policy Governance

- This policy is owned by the Policy Owner and reviewed at least annually.
- All staff and contractors are expected to read and comply with it.
- Violations may result in loss of access and/or termination of engagement.

---

*Approved by:* __________________________  (Ophir Schultz, Owner, Shipo LLC)

*Date:* __________________________
