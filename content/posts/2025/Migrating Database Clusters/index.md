---
title: Migrating Database Clusters
description: "When recovery goes bad"
date: 2025-02-01
slug: "2025/migrating-database-clusters"
toc: true
math: false
draft: false
Tags:
  - Kubernetes
  - Database
  - Postgres
  - Maintenance
Categories: [Kubernetes, Database]
---

> "The most powerful database is the one you don’t have to recover."  
> — *Unknown*

## Recovery gone bad
One of the nice things about how I have my Kubernetes cluster configured is that I use Volsync paired with backblaze B2 and Cloudflare R2 to backup (and recover) all my PVCs for my containers.
This means that When I need to totally blow away a container because something has gone wrong, volsync will reach out to my replicationDestination (Backblaze) and pull the latest backup down to build out a new PVC locally.

Recently, I had to shutdown my entire cluster due to my local power company needing to install a new "Smart Metre".
Under normal circumstances, when the cluster stood back up, Volsync would reach out to Backblaze and rebuild all the PVCs.
And this worked almost flawlessly.

Only one Postgres node was able to recover, the other two got the following error.

```bash
file name too long for tar format
```

This seems to have been cause by a [bug](https://github.com/tensorchord/pgvecto.rs/issues/570).

I was not running standard Cloudnative Postgres.
In the past, I had run an application called [immich](https://immich.app/) which is both amazing, and aweful at the same time.

Amazing because it did everything I wanted a photo application to do, aweful because nearly every update was a breaking change. 

Eventually I got rid of immich.
However, Immich needed an extention called `pgvecto.rs` in Postgres in order for it work correctly. To make my life easier at the time, I ran a [custom image of Cloudnative Postgres from tensorchord](ghcr.io/tensorchord/cloudnative-pgvecto.rs) with pgvecto.rs baked in.

Due to the aforementioned bug, I was not able to restore because the file names for some of the backed up files were too large and so I was only running on a single node.

### Failed attempts to recover

So what did I try to resolve the issue?

1.  Deleted the Immich DB and confirmed no other databases used the pgvecto.rs extension
1.  Forced a new backup to recover from
1.  Migrated to vanilla Cloudnative-PG
1.  Forced a new backup to recover from

None of these things worked.
After talking to the amazing community in the [Home Operations Discord](https://discord.gg/home-operations) there was only one path forward

## Database Migration

### High Level Process

I was going to need to run a brand new Cloudnative-PG v17.2 cluster side by side with my existing Cloudnative-PG v16.3-7 cluster and import my existing databases contents to the new database.

Thankfully, this is much easier than I first thought.

### Baked in support for Recovery and existing clusters

I was already using Cloudnative-PGs recovery process as a way to recover when I had DB issues

```yaml
  backup:
    retentionPolicy: 30d
    barmanObjectStore: &barmanObjectStore
      data:
        compression: bzip2
      wal:
        compression: bzip2
        maxParallel: 8
      destinationPath: s3://nerdz-cloudnative-pg/
      endpointURL: https://s3.us-east-005.backblazeb2.com
      serverName: &currentCluster postgres16-v3
      s3Credentials:
        accessKeyId:
          name: cloudnative-pg-secret
          key: aws-access-key-id
        secretAccessKey:
          name: cloudnative-pg-secret
          key: aws-secret-access-key
  # Note: externalClusters is needed when recovering from an existing cnpg cluster
  bootstrap:
    recovery:
      source: &previousCluster postgres16-v1
  # Note: externalClusters is needed when recovering from an existing cnpg cluster
  externalClusters:
    - name: *previousCluster
      barmanObjectStore:
        <<: *barmanObjectStore
        serverName: *previousCluster
```

This block of code is what I use to recover my Database under normal circumstances.
Just give the currentCluster a new number and specify the number for the old cluster and viola, recovered.

But in this case, I was going to have to do something a little different

### How to recover from an existing (external) cluster

In the new cluster files change the `Bootstrap` and `externalClusters` to look like this

```yaml
  bootstrap:
    # recovery:
    #   source: &previousCluster postgres17v1
    initdb:
      import:
        type: monolith
        databases: ["*"]
        roles: ["*"]
        source:
          externalCluster: cnpg16
  # Note: externalClusters is needed when recovering from an existing cnpg cluster
  externalClusters:
    # - name: *previousCluster
    #   barmanObjectStore:
    #     <<: *barmanObjectStore
    #     serverName: *previousCluster
    - name: cnpg16
      connectionParameters:
        host: postgres16-rw.database.svc.cluster.local
        user: postgres
        dbname: postgres
      password:
        name: cloudnative-pg-secret
        key: password
```

You will see here that the host for the initDb is my existing Cloudnative-PG clusters service

`postgres16-rw.database.svc.cluster.local` this translate to `serviceName.NameSpace.svc.cluster.local`

You can see my files on [Github](https://github.com/gavinmcfall/home-ops/tree/main/kubernetes/apps/database/cloudnative-pg/cluster17)

After pushing the changes you will see an import pod turn up which will pull all the data over and then the Cloudnative-PG Operator will spin up a pod with Cloudnative-PG v17 running

In my case, only a single pod, as I had scaled down Cloudnative-PG v16 to a single pod to remove all the error from the restore, and I was lasy and copy pasted all the old files when creating the new cluster and missed this detail when making my changes.

### Scaling up the deployment to 3

```yaml
# yaml-language-server: $schema=https://kubernetes-schemas.pages.dev/postgresql.cnpg.io/cluster_v1.json
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: postgres17
spec:
  instances: 3
```

Set the instances to 3 and push the change

using k9s I can watch the process unfold. First you will see a post named `postgres17-2-join-garbageString` as it joins the new pod at which point you will see the `postgres17-2-garbageString` pod running nicely.
Eventually, you will see something like this

![Cloudnative-PG 17 Cluster Running](/cnp17-running.png)


## Next Steps

### Migrating apps to using the new cluster

Take a look at your services in your database namespace.

```bash
kubectl get svc -n database | grep postgres
```

and you will see something like this

```bash
postgres-lb                                        LoadBalancer   10.96.91.59     10.90.3.203   5432:32588/TCP                                                11d
postgres16-r                                       ClusterIP      10.96.150.103   <none>        5432/TCP                                                      11d
postgres16-ro                                      ClusterIP      10.96.174.223   <none>        5432/TCP                                                      11d
postgres16-rw                                      ClusterIP      10.96.134.59    <none>        5432/TCP                                                      11d
postgres17-lb                                      LoadBalancer   10.96.222.51    10.90.3.210   5432:32310/TCP                                                17m
postgres17-r                                       ClusterIP      10.96.108.178   <none>        5432/TCP                                                      17m
postgres17-ro                                      ClusterIP      10.96.6.175     <none>        5432/TCP                                                      17m
postgres17-rw                                      ClusterIP      10.96.156.130   <none>        5432/TCP                                                      17m
```

Here you can see that we have matching sets of postgres services with the old one at 10.90.3.203 and the new one at 10.90.3.210 (Your IPs will vary based on your cluster)

### Moving apps to the new cluster

I use VS Code for interacting with my code for my cluster. all I need to do is a search for uses of `postgres16-rw.database.svc.cluster.local` to find all the apps using Postgres.

From here I will pick an single app and and change it over to `postgres17-rw.database.svc.cluster.local`
Push the change and confirm it worked

I will use Sonarr for my test.

When I log into Sonarr and go to `Status` `https://yourSonarURL/system/status` you will see in the about section that its currently connected to Postgresql 16.3

![Sonarr - Before](/sonarr-01.png)

I need to edit my externalSecret to move the host for Postgres to the new cluster.
Because I used all the same usernames and passworda as my original cluster, nothing else needs to change

In Sonarr's `externalsecret.yaml` I change the host

```yaml
metadata:
  name: sonarr
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: onepassword-connect
  target:
    name: sonarr-secret
    template:
      engineVersion: v2
      data:
        SONARR__AUTH__APIKEY: "{{ .SONARR_API_KEY }}"
        SONARR__POSTGRES__HOST: &dbHost postgres17-rw.database.svc.cluster.local
```

run the following command to confirm the change to the secret

```bash
kubectl describe externalsecret sonarr -n downloads
```

Be sure to swap our the name of the secret and the namespace to match your app and namespace.

You should see the host has changed

Go and refresh your Sonarr URL and you should see it changed there too

![Sonarr - After](/sonarr-02.png)

If you want to be doubly sure, delete your sonarr pod and let k8s recreate it and check again that everything looks good.
Once you are happy, migrate your other apps

### All Apps Migrated

Once you have migrated all your apps and you can confirm that they are working, you can update your new Cloudnative-PG cluster to remove the InitDB and externalCluster settings you had that pointed to the old external cluster and go back to just having the standard settings you have for Volsync recovery:

```yaml
  bootstrap:
    recovery:
      source: &previousCluster postgres17v1
  # Note: externalClusters is needed when recovering from an existing cnpg cluster
  externalClusters:
    - name: *previousCluster
      barmanObjectStore:
        <<: *barmanObjectStore
        serverName: *previousCluster
```

### Scale down / removal of old cluster

At this point, I want scale down your old cluster. Leave all the files there and let it sit for a week or two so you can be 100% sure everything is running fine, before you remove it from your Git

#### Note
-   Because we are running two clusters under Cloudnative-PG we cannot simply scale the deployment to 0, as this will scale down both clusters.
-   We also can not set the instances to 0 as that is not valid configuration option for Cloudnative-PG

Instead, we need to comment out the KS that sets up the cluster

In your root `ks.yaml` file kubernetes/apps/database/cloudnative-pg/ks.yaml
Comment out the section for the original cluster

```yaml
# ---
# yaml-language-server: $schema=https://kubernetes-schemas.pages.dev/kustomize.toolkit.fluxcd.io/kustomization_v1.json
# apiVersion: kustomize.toolkit.fluxcd.io/v1
# kind: Kustomization
# metadata:
#   name: &app cloudnative-pg-cluster
#   namespace: flux-system
# spec:
#   targetNamespace: database
#   commonMetadata:
#     labels:
#       app.kubernetes.io/name: *app
#   dependsOn:
#     - name: cloudnative-pg
#     - name: external-secrets-stores
#   path: ./kubernetes/apps/database/cloudnative-pg/cluster
#   prune: true
#   sourceRef:
#     kind: GitRepository
#     name: home-kubernetes
#   wait: true
#   interval: 30m
#   retryInterval: 1m
#   timeout: 5m
#   postBuild:
#     substitute:
#       APP: *app
#       GATUS_SVC_NAME: postgres-lb
#       GATUS_SVC_PORT: "5432"
#       GATUS_NAMESPACE: database
```

Note: You may need to remove the finalizers on the PVC which have protection for Cloudnative-PG in order for the cleanup to complete

```bash
kubectl get pvc -n database
```

```bash
NAME           STATUS        VOLUME                                     CAPACITY   ACCESS MODES   STORAGECLASS       VOLUMEATTRIBUTESCLASS   AGE
postgres16-1   Terminating   pvc-753ef28f-9f40-44aa-bc33-24f3db0abbfb   20Gi       RWO            openebs-hostpath   <unset>                 11d
postgres17-1   Bound         pvc-df4cbbb0-a2f2-4eb5-8377-09c68f6f8942   20Gi       RWO            openebs-hostpath   <unset>                 62m
postgres17-2   Bound         pvc-696e5ed8-7a0a-4640-8e3f-55d36d69343c   20Gi       RWO            openebs-hostpath   <unset>                 56m
postgres17-3   Bound         pvc-fd1344dd-f596-4ed3-a350-718c69c161f3   20Gi       RWO            openebs-hostpath   <unset>                 52m
```

```bash
kubectl edit pvc postgres16-1 -n database
```

Remove the finalizer lines and save

### Done

You have successfully migrated your Database.


### Final Checks

1.  Log into your replicationDestination (Backblaze in my case) and check that the first backup has taken place
1.  Check all your pods and make sure none are throwing errors
1.  Continue to monitor your cluster over the coming weeks for any DB related errors
1.  Once you are totally happy, remove all the old files from Git.