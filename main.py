from __future__ import annotations

from app import create_app
import os


app = create_app()


if __name__ == "__main__":
    # Development server; in productie run je via een WSGI/ASGI server.
    # Keep reloader off to avoid interrupting in-flight uploads.
    debug = os.getenv("FLASK_DEBUG", "0").lower() in {"1", "true", "yes", "on"}
    app.run(debug=debug, use_reloader=False)

