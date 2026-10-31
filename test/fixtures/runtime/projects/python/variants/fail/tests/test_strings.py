import unittest

from slugs.strings import capitalize, slugify


class StringsTest(unittest.TestCase):
    def test_capitalize(self):
        self.assertEqual(capitalize("hello"), "Hello")

    def test_slugify(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("  a  b  "), "a-b")
        self.assertEqual(slugify(""), "")


if __name__ == "__main__":
    unittest.main()
