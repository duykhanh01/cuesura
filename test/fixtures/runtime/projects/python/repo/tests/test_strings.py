import unittest

from slugs.strings import capitalize


class StringsTest(unittest.TestCase):
    def test_capitalize(self):
        self.assertEqual(capitalize("hello"), "Hello")


if __name__ == "__main__":
    unittest.main()
