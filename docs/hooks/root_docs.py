"""Hook de MkDocs: publica README.md y CHANGELOG.md (raíz del repo) como páginas.

Los dos ficheros viven en la raíz porque GitHub los muestra ahí; aquí se
inyectan en el sitio como `index.md` y `changelog.md` sin copiarlos al
repositorio, reescribiendo los enlaces relativos para que apunten a las
páginas del sitio. También expone el logo (icons/icon.svg) en assets/.
"""

from pathlib import Path

from mkdocs.structure.files import File

ROOT = Path(__file__).resolve().parents[2]

# (fichero en la raíz, ruta dentro del sitio, [(enlace original, enlace en el sitio), ...])
ROOT_PAGES = (
    (
        "README.md",
        "index.md",
        (
            ("(docs/ARQUITECTURA.md)", "(ARQUITECTURA.md)"),
            ("(CHANGELOG.md)", "(changelog.md)"),
        ),
    ),
    ("CHANGELOG.md", "changelog.md", ()),
)

ASSETS = (("icons/icon.svg", "assets/icon.svg"),)


def on_files(files, config):
    for source, target, rewrites in ROOT_PAGES:
        content = (ROOT / source).read_text(encoding="utf-8")
        for old, new in rewrites:
            content = content.replace(old, new)
        files.append(File.generated(config, target, content=content))

    for source, target in ASSETS:
        files.append(File.generated(config, target, abs_src_path=str(ROOT / source)))

    return files
