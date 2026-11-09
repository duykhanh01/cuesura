def capitalize(text):
    return text[:1].upper() + text[1:]


def slugify(text):
    return text.lower().replace(" ", "-")
