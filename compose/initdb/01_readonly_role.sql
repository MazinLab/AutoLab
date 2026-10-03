\getenv autolab_db POSTGRES_DB
\getenv autolab_ro_password POSTGRES_RO_PASSWORD

CREATE ROLE autolab_ro LOGIN PASSWORD :'autolab_ro_password';

GRANT CONNECT ON DATABASE :"autolab_db" TO autolab_ro;
GRANT USAGE ON SCHEMA public TO autolab_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO autolab_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT ON TABLES TO autolab_ro;
