import re


def capitalize(text):
    return text[:1].upper() + text[1:]


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
