# Analyse Complète — Unified Inbox

> Analyse du repository réalisée le 12 mai 2026.

---

## Table des Matières

1. [Architecture Globale](#1-architecture-globale)
2. [Technologies Utilisées](#2-technologies-utilisées)
3. [Flux Backend/Frontend](#3-flux-backendfrontend)
4. [APIs](#4-apis)
5. [Services Kubernetes](#5-services-kubernetes)
6. [Pipeline CI/CD](#6-pipeline-cicd)
7. [Mécanismes de Sécurité](#7-mécanismes-de-sécurité)
8. [Dépendances Importantes](#8-dépendances-importantes)
9. [Points Techniques Complexes](#9-points-techniques-complexes)

---

## 1. Architecture Globale

```
Internet → Traefik (TLS/HTTPS) → K8s Ingress
                                    ├── / → frontend (Nginx + React SPA)
                                    └── /api, /socket.io → backend (Express + Socket.IO)
                                                              └── MongoDB Atlas (cloud)

Canaux externes → Meta Graph API v24.0 → Webhooks POST → backend
                → Gmail IMAP (polling)  → backend
```

Le backend est un **monolithe Express modulaire** qui sert à la fois d'API REST et de serveur Socket.IO. En production, il peut aussi servir le build React en fallback (le frontend Nginx est préféré).

### Topologie K8s

```
☁️ Azure VM (k3s single-node)
└── Namespace: production
    ├── Traefik Ingress  →  unified-inbox.duckdns.org (HTTPS)
    ├── frontend-service (ClusterIP :3000)  →  Frontend Pods × 1–3
    └── backend-service  (ClusterIP :5000)  →  Backend Pods  × 2
                                                    └── backend-secrets (K8s Secret)
```

---

## 2. Technologies Utilisées

### Backend (Node.js 22)

| Bibliothèque                 | Version   | Rôle                                 |
| ---------------------------- | --------- | ------------------------------------ |
| Express                      | 4.18      | Framework HTTP                       |
| Socket.IO                    | 4.8       | Temps réel bidirectionnel            |
| Mongoose                     | 8.2       | ODM MongoDB                          |
| jsonwebtoken                 | 9.0       | JWT stateless (7 jours)              |
| bcryptjs                     | 2.4       | Hash passwords (10 salt rounds)      |
| axios                        | 1.15      | Appels Meta Graph API v24.0          |
| imap                         | 0.8       | Polling IMAP Gmail                   |
| mailparser                   | 3.9       | Parsing MIME / HTML / pièces jointes |
| nodemailer                   | 8.0       | Envoi SMTP                           |
| passport + passport-facebook | 0.7 / 3.0 | OAuth Facebook                       |
| cors                         | 2.8       | CORS middleware                      |
| dotenv                       | 16        | Chargement variables d'environnement |

### Frontend (React 18)

| Bibliothèque     | Version | Rôle                     |
| ---------------- | ------- | ------------------------ |
| React            | 18.2    | UI library               |
| React Router     | 6.22    | SPA routing côté client  |
| socket.io-client | 4.8     | Notifications temps réel |
| axios            | 1.15    | Appels API REST          |
| react-scripts    | 5.0     | Build tooling (CRA)      |

### Infrastructure & DevOps

| Technologie                 | Rôle                                   |
| --------------------------- | -------------------------------------- |
| MongoDB Atlas               | Base managée cloud                     |
| Docker (Alpine multi-stage) | Images conteneurisées durcies          |
| Nginx stable-alpine         | Serveur statique frontend              |
| Kubernetes k3s              | Orchestration sur Azure VM             |
| Traefik                     | Ingress controller + TLS termination   |
| cert-manager                | Certificats Let's Encrypt automatiques |
| GitHub Actions              | Pipeline DevSecOps 13 stages           |
| Grafana + Prometheus        | Observabilité                          |
| Kyverno                     | Admission controller K8s               |

### Outils Sécurité (DevSecOps)

| Outil          | Stage       | Rôle                                   |
| -------------- | ----------- | -------------------------------------- |
| ESLint         | Lint        | Analyse statique code                  |
| Semgrep        | SAST        | Vulnérabilités OWASP Top-10            |
| npm audit      | SCA         | CVEs dépendances                       |
| Trivy (fs)     | SCA         | Scan filesystem                        |
| Gitleaks       | Secret Scan | Secrets dans l'historique Git          |
| Trivy (image)  | Image Scan  | CVEs container                         |
| Syft           | SBOM        | Software Bill of Materials (SPDX JSON) |
| Cosign         | Sign        | Signature keyless (Sigstore)           |
| kubesec        | K8s Scan    | Score sécurité manifests               |
| Trivy (config) | K8s Scan    | Misconfigurations manifests            |
| OWASP ZAP      | DAST        | Scan dynamique sur staging             |
| Kyverno        | Runtime     | Politiques d'admission cluster         |

---

## 3. Flux Backend/Frontend

### Authentification

```
POST /api/auth/login  {email, password}
  → bcrypt.compare(password, hash)
  → jwt.sign({ id }, JWT_SECRET, { expiresIn: "7d" })
  → { _id, firstName, lastName, email, role, token }
  → localStorage.setItem("user", JSON.stringify(data))
  → axios Authorization: Bearer <token>  sur chaque requête
```

### Temps Réel (Socket.IO)

```
Client → socket.emit("join", userId)  → rejoint room userId
Webhook Meta entrant:
  → Message.create() en MongoDB
  → io.emit("new_message", { platform, conversationId, message })
  → Tous les clients connectés reçoivent l'événement instantanément
```

### Routage SPA (React Router v6)

| Route                | Protection                      | Composant                        |
| -------------------- | ------------------------------- | -------------------------------- |
| `/login`             | Public                          | `Login.js`                       |
| `/terms`, `/privacy` | Public                          | Pages légales                    |
| `/inbox`             | `ProtectedRoute` (tout rôle)    | `Inbox.js`                       |
| `/admin`             | `ProtectedRoute` role=admin     | `AdminDashboard.js`              |
| `/manager`           | `ProtectedRoute` role=manager   | `ManagerDashboard.js`            |
| `/marketing`         | `ProtectedRoute` role=marketing | `MarketingDashboard.js`          |
| `/*`                 | —                               | `RootRedirect` → `/${user.role}` |

### Proxy de développement

`client/package.json` : `"proxy": "http://localhost:5000"` — tous les `/api/*` sont proxifiés vers le backend en mode dev.

### Dual-mode serveur

`server/index.js` détecte `NODE_ENV=development` ou `npm_lifecycle_event=server:dev` pour **ne pas** servir le build React stale en développement. En production, il sert `client/build/` en catch-all pour React Router.

---

## 4. APIs

### Authentification

| Méthode | Endpoint                | Auth       | Description                |
| ------- | ----------------------- | ---------- | -------------------------- |
| `POST`  | `/api/auth/login`       | Public     | Login email/password → JWT |
| `POST`  | `/api/auth/create-user` | Admin JWT  | Créer un utilisateur       |
| `GET`   | `/api/auth/me`          | Bearer JWT | Utilisateur courant        |

#### Exemple Login

```http
POST /api/auth/login
Content-Type: application/json

{ "email": "admin@example.com", "password": "yourpassword" }
```

```json
{
  "_id": "663f...",
  "firstName": "Adem",
  "email": "admin@example.com",
  "role": "admin",
  "token": ""
}
```

### Dashboards (role-gated)

| Méthode | Endpoint                   | Auth      |
| ------- | -------------------------- | --------- |
| `GET`   | `/api/dashboard/admin`     | Admin     |
| `GET`   | `/api/dashboard/manager`   | Manager   |
| `GET`   | `/api/dashboard/marketing` | Marketing |

### Messagerie Multi-Canal

| Méthode | Endpoint                       | Description                 |
| ------- | ------------------------------ | --------------------------- |
| `GET`   | `/api/instagram/conversations` | DMs Instagram via Graph API |
| `POST`  | `/api/instagram/reply`         | Réponse DM Instagram        |
| `GET`   | `/api/facebook/conversations`  | Messenger via Graph API     |
| `POST`  | `/api/facebook/reply`          | Réponse Messenger           |
| `GET`   | `/api/email/messages`          | 50 derniers emails (IMAP)   |
| `POST`  | `/api/email/send`              | Envoi email (SMTP)          |

### Webhooks Meta (publics, vérifiés)

| Méthode | Endpoint                  | Mécanisme                        |
| ------- | ------------------------- | -------------------------------- |
| `GET`   | `/api/webhooks/instagram` | Challenge `verify_token`         |
| `POST`  | `/api/webhooks/instagram` | Signature HMAC-SHA256            |
| `GET`   | `/api/webhooks/facebook`  | Challenge `verify_token`         |
| `POST`  | `/api/webhooks/facebook`  | Signature HMAC-SHA256            |
| `GET`   | `/api/webhooks/debug`     | Admin — log des 50 derniers hits |

### Classifications

| Méthode | Endpoint                                  | Description                |
| ------- | ----------------------------------------- | -------------------------- |
| `GET`   | `/api/classifications?platform=instagram` | Récupérer les tags         |
| `PUT`   | `/api/classifications`                    | Créer/mettre à jour un tag |

**Valeurs valides** : `cible`, `hors_cible`, `non_classifie`, `suivi`, `priorite`

### Verrouillage de Conversations

| Méthode  | Endpoint                        | Description                 |
| -------- | ------------------------------- | --------------------------- |
| `GET`    | `/api/locks?platform=instagram` | Verrous d'une plateforme    |
| `GET`    | `/api/locks/all`                | Tous les verrous (Admin)    |
| `POST`   | `/api/locks/:conversationId`    | Verrouiller (claim)         |
| `DELETE` | `/api/locks/:conversationId`    | Force-déverrouiller (Admin) |

### Conversations

| Méthode  | Endpoint                 | Description                |
| -------- | ------------------------ | -------------------------- |
| `DELETE` | `/api/conversations/:id` | Supprimer une conversation |

---

## 5. Services Kubernetes

| Ressource K8s           | Nom                             | Configuration                                               |
| ----------------------- | ------------------------------- | ----------------------------------------------------------- |
| Deployment              | `backend`                       | 2 replicas, rolling update (maxUnavailable: 0, maxSurge: 1) |
| Deployment              | `frontend`                      | 1 replica min, image Nginx Alpine                           |
| Service                 | `backend-service`               | ClusterIP :5000                                             |
| Service                 | `frontend-service`              | ClusterIP :3000                                             |
| Ingress                 | `unified-inbox-ingress`         | Traefik TLS, `unified-inbox.duckdns.org`                    |
| HPA                     | `backend-hpa`                   | 1→3 replicas à 80% mémoire                                  |
| HPA                     | `frontend-hpa`                  | 1→3 replicas à 80% mémoire                                  |
| PDB                     | `backend-pdb`                   | `minAvailable: 1`                                           |
| PDB                     | `frontend-pdb`                  | `minAvailable: 1`                                           |
| NetworkPolicy           | `backend-netpol`                | Ingress : frontend + Traefik uniquement                     |
| NetworkPolicy           | `frontend-netpol`               | Ingress : Traefik uniquement                                |
| NetworkPolicy           | `default-deny-all`              | Deny-all par défaut dans le namespace                       |
| Secret                  | `backend-secrets`               | Injecté via `envFrom.secretRef`                             |
| ClusterPolicy (Kyverno) | `disallow-root-user`            | Enforce                                                     |
| ClusterPolicy (Kyverno) | `disallow-privilege-escalation` | Enforce                                                     |
| ClusterPolicy (Kyverno) | `require-resource-limits`       | Enforce                                                     |
| ClusterPolicy (Kyverno) | `require-probes`                | Enforce                                                     |

### SecurityContext des pods backend

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  fsGroup: 1000
containers:
  - securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop: [ALL]
      resources:
        requests: { memory: "256Mi", cpu: "100m" }
        limits: { memory: "512Mi", cpu: "500m" }
```

---

## 6. Pipeline CI/CD

**13 stages** définis dans `.github/workflows/devsecops.yml`, déclenchés sur push/PR vers `main`.

```
Push / PR → main
│
├── Stage 1  : Lint          (ESLint backend + frontend)
│
├── Stage 2  : Test          (npm test + react-scripts test)      ─┐
├── Stage 3  : SAST          (Semgrep OWASP Top-10)               │ bloquent
├── Stage 4  : SCA           (npm audit + Trivy fs)               │ le build
├── Stage 5  : Secret Scan   (Gitleaks full history)              │
└── Stage 10 : K8s Scan      (kubesec + Trivy config)            ─┘
│
├── Stage 6  : Build         (Docker buildx → Docker Hub)
│   ├── Stage 7  : Image Scan    (Trivy HIGH/CRITICAL CVEs)
│   └── Stage 8  : SBOM          (Syft → artifact SPDX JSON)
│
├── Stage 9  : Sign          (Cosign keyless Sigstore)
│
├── Stage 11 : Deploy Staging   (SSH + kubectl namespace staging)
│
├── Stage 12 : DAST          (OWASP ZAP baseline scan)
│
└── [MANUAL APPROVAL — GitHub Environments]
    │
    └── Stage 13 : Deploy Production  (https://unified-inbox.duckdns.org)
```

> La production nécessite une **approbation manuelle** via GitHub Environments. Aucun code n'atteint la production sans validation humaine.

---

## 7. Mécanismes de Sécurité

### Application

| Contrôle                 | Implémentation                                                          |
| ------------------------ | ----------------------------------------------------------------------- |
| Hash passwords           | `bcryptjs`, 10 salt rounds, `pre('save')` Mongoose                      |
| JWT                      | HS256, 7 jours, secret stocké dans K8s Secret                           |
| RBAC                     | Middleware `protect` (vérif token) + `authorize(...roles)` (vérif rôle) |
| Vérification webhooks    | HMAC-SHA256 avec `FACEBOOK_APP_SECRET` (header `x-hub-signature-256`)   |
| Pas de secrets hardcodés | Tout via `.env` / K8s Secrets, `.env` dans `.gitignore`                 |

### Container

| Contrôle                     | Implémentation                                      |
| ---------------------------- | --------------------------------------------------- |
| Image minimale               | `node:22-alpine`, `nginx:stable-alpine`             |
| Utilisateur non-root         | `runAsUser: 1000`, `adduser -u 1001 appuser`        |
| Capabilities droppées        | `capabilities.drop: [ALL]`                          |
| Pas d'escalade de privilèges | `allowPrivilegeEscalation: false` (Kyverno enforce) |
| Image signée                 | Cosign keyless Sigstore, `imagePullPolicy: Always`  |
| Health checks                | `HEALTHCHECK` dans les Dockerfiles + probes K8s     |

### Réseau

| Contrôle                 | Implémentation                                           |
| ------------------------ | -------------------------------------------------------- |
| Default deny             | `NetworkPolicy default-deny-all` dans le namespace       |
| Isolation backend        | Accepte uniquement frontend pods + Traefik (kube-system) |
| Egress backend restreint | DNS (53), MongoDB Atlas (27017), HTTPS (443)             |
| TLS end-to-end           | cert-manager + Let's Encrypt via Traefik                 |

### Couverture OWASP Top 10

| Risque OWASP                  | Mitigation                                                 |
| ----------------------------- | ---------------------------------------------------------- |
| A01 Broken Access Control     | RBAC middleware, vérification de rôle sur chaque endpoint  |
| A02 Cryptographic Failures    | bcrypt, HTTPS imposé, secrets en K8s Secrets               |
| A03 Injection                 | Mongoose ODM (requêtes paramétrées), validation des inputs |
| A05 Security Misconfiguration | Kyverno policies, Trivy config, kubesec                    |
| A06 Vulnerable Components     | npm audit + Trivy SCA à chaque pipeline                    |
| A07 Auth Failures             | JWT expiry, vérification JWT_SECRET au démarrage           |
| A09 Logging Failures          | Endpoint debug protégé, logs structurés console            |

---

## 8. Dépendances Importantes

### Backend (critiques)

```
express       → serveur HTTP
mongoose      → accès MongoDB Atlas
socket.io     → push temps réel
jsonwebtoken  → émission/vérification JWT
bcryptjs      → sécurité des mots de passe
axios         → appels Meta Graph API v24.0
imap          → lecture emails Gmail
nodemailer    → envoi emails SMTP
```

### Frontend (critiques)

```
react + react-dom       → rendu UI
react-router-dom        → navigation SPA
socket.io-client        → réception events temps réel
axios                   → appels API REST
```

### Services Externes (dépendances runtime)

| Service              | Usage                                       |
| -------------------- | ------------------------------------------- |
| MongoDB Atlas        | Persistance de toutes les données           |
| Meta Graph API v24.0 | Instagram DMs, Facebook Messenger, WhatsApp |
| Gmail IMAP/SMTP      | Réception et envoi d'emails                 |
| Docker Hub           | Registre des images de production           |
| DuckDNS              | DNS dynamique pour le domaine public        |
| Let's Encrypt        | Certificats TLS gratuits                    |

---

## 9. Points Techniques Complexes

### 1. Agrégation multi-canaux dans un modèle unifié

Le modèle `Message` abstrait tous les canaux avec un champ `platform` (enum : `instagram`, `facebook`, `whatsapp`, `email`, `messenger`, `tiktok`) et un `conversationId` commun. Des index composites `{ platform, conversationId }` et `{ platform, senderId }` optimisent les lookups.

### 2. Résolution des noms d'expéditeurs Instagram/Facebook

La fonction `getSenderName()` dans [`server/routes/webhooks.js`](../server/routes/webhooks.js) :

- Interroge Graph API avec un **timeout de 5s** pour ne pas bloquer les webhooks
- A un **fallback** via `/{pageId}/conversations` pour les PSIDs Facebook
- Filtre les noms qui ressemblent à des raw numeric IDs (regex `^\d{6,}$`)

### 3. Instagram DMs : inbox vs message requests ("other")

[`server/routes/instagram.js`](../server/routes/instagram.js) effectue **3 appels Graph API** :

1. `folder=inbox` — conversations normales
2. `folder=other` — message requests (personnes non-suivies)
3. Sans filtre `platform` — DMs qui n'apparaissent dans aucun des deux dossiers

C'est un workaround d'une limitation documentée de l'API Instagram Graph.

### 4. Email IMAP : pièces jointes inline CID → base64

[`server/routes/email.js`](../server/routes/email.js) convertit les pièces jointes inline (`cid:...`) en `data:` URI base64 dans le HTML parsé. Permet un rendu correct dans l'interface web sans stocker de fichiers temporaires sur le serveur.

### 5. Verrouillage de conversation distribué

Le modèle `ConversationLock` utilise `{ conversationId, platform }` comme clé unique. Plusieurs agents peuvent travailler en parallèle sur des conversations différentes sans collision. Un admin peut force-déverrouiller via `DELETE /api/locks/:conversationId`.

### 6. Socket.IO avec rooms par userId

```javascript
// server/index.js
socket.on("join", (userId) => socket.join(userId));
// Dans les webhooks :
io.emit("new_message", data); // broadcast global
```

Le broadcast est global (pas de ciblage par rôle). Point d'amélioration potentiel : émettre vers des rooms spécifiques par rôle.

### 7. Dual-mode serveur (dev vs prod)

```javascript
const isLocalDevRun =
  process.env.NODE_ENV === "development" ||
  process.env.npm_lifecycle_event === "server:dev";

if (!isLocalDevRun && fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  app.get("*", (req, res) =>
    res.sendFile(path.join(clientBuildPath, "index.html")),
  );
}
```

Évite de servir un build React stale en développement.

### 8. Pipeline DAST gate avant production

Le staging namespace est un miroir de production. OWASP ZAP exécute un baseline scan sur l'URL staging, puis une **approbation manuelle GitHub Environments** est requise avant tout déploiement en production. Pattern DevSecOps complet rare dans un projet académique.

### 9. Kyverno admission control en mode Enforce

Les 4 ClusterPolicies Kyverno sont en mode `Enforce` (pas `Audit`), ce qui signifie que tout pod ne respectant pas les règles de sécurité est **rejeté à l'admission** par l'API server K8s, sans possibilité de bypass.
