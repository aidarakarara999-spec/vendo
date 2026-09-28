# Vendo 5.11 — SaaS e-commerce

Vendo est une plateforme e-commerce mobile-first pensée pour les commerçants, avec FCFA, livraison, commandes et une architecture de paiement adaptée au Sénégal.

## Inclus
- création de boutique et authentification
- vitrine publique `/boutique/<slug>`
- catalogue, catégories, variantes et stock
- panier et checkout
- commandes, clients et suivi public
- zones de livraison
- coupons et analytics
- notifications et paramètres de boutique
- architecture COD + connecteurs préparatoires Wave / Orange Money
- contact vendeur via WhatsApp
- endpoints d'administration de base

## Paiements
Le paiement à la livraison fonctionne sans compte externe. Wave et Orange Money sont volontairement désactivés par défaut (`WAVE_ENABLED=false`, `ORANGE_MONEY_ENABLED=false`) tant que les identifiants/API officiels du compte marchand ne sont pas configurés. Cela évite d'afficher un moyen de paiement qui ne peut pas réellement finaliser une transaction.

Après activation, définir les variables correspondantes à `true` et brancher les appels officiels du prestataire ainsi que le webhook. `WEBHOOK_SECRET` peut protéger le webhook générique.

## Déploiement
1. Créer une base PostgreSQL.
2. Déployer le projet sur Render ou un hébergeur Node compatible.
3. Définir `DATABASE_URL`; en production, `JWT_SECRET` doit être fourni.
4. Le build exécute `prisma generate` puis `prisma migrate deploy`.
5. Le démarrage vérifie la connexion PostgreSQL via les endpoints `/api/health` et `/api/ready`.

## Vérifications
- migration Prisma initiale incluse dans `prisma/migrations/0001_initial/`
- serveur Express 5 avec route SPA compatible
- protection JWT par cookie HTTP-only
- limitation de débit basique
- décrément de stock protégé contre le surbooking concurrent
- arrêt propre du processus

## Limites de la mise en ligne
Cette archive est déployable mais elle n'est pas, à elle seule, une URL publique. La création du compte d'hébergement, de la base PostgreSQL, du domaine et des comptes marchands de paiement reste une étape externe nécessitant les accès du propriétaire.


## Déploiement Blueprint
Le fichier `render.yaml` peut provisionner le service Node et PostgreSQL ensemble. Il relie automatiquement `DATABASE_URL` au PostgreSQL du Blueprint. Les secrets externes restent demandés séparément.

## Vérification locale sans base
- `node --check server.js`
- `node --check prisma/seed.js`

Le démarrage complet nécessite `DATABASE_URL` et les dépendances installées.

## Contrôle final V5.11
- version API synchronisée sur 5.11.0
- webhook vérifie désormais aussi le fournisseur de la transaction
- correction du checkout public : le contact WhatsApp utilise bien la boutique active

## Production 5.12

Le fichier `render.production.yaml` propose des plans payants adaptés à une utilisation durable. Le `render.yaml` reste volontairement un profil de test gratuit : Render indique que les bases Postgres gratuites expirent après 30 jours.

Le serveur écoute explicitement sur `0.0.0.0` pour les déploiements web.
