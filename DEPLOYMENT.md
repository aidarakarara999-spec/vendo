# Vendo — mise en ligne

## Test gratuit
Le `render.yaml` principal utilise les plans gratuits pour permettre un premier test. Render indique que les bases Postgres gratuites sont limitées à 1 Go et expirent après 30 jours : ne pas utiliser cette configuration comme stockage permanent de production.

## Production
Utiliser `render.production.yaml` avec un service web et PostgreSQL payants. Le Blueprint relie automatiquement `DATABASE_URL` au service PostgreSQL.

## Étapes
1. Mettre ce dossier dans un dépôt GitHub/GitLab connecté à Render.
2. Dans Render : **New → Blueprint** puis sélectionner le dépôt.
3. Pour un test, conserver `render.yaml`. Pour la vraie production, choisir `render.production.yaml` comme Blueprint à appliquer.
4. Vérifier que `JWT_SECRET` est généré et que `WEBHOOK_SECRET` est défini avant d'activer un fournisseur de paiement.
5. Déployer et ouvrir l'URL `https://<service>.onrender.com`.
6. Vérifier `/api/health` et `/api/ready`.
7. Ajouter ensuite le domaine personnalisé.

## Paiements
Wave et Orange Money restent désactivés tant que les accès/API officiels du compte marchand ne sont pas fournis. Le paiement à la livraison fonctionne indépendamment.
