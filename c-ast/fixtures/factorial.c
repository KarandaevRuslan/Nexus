#include <stdio.h>

int factorial(int n) {
    int acc = 1;
    for (int i = 2; i <= n; ++i) {
        acc = acc * i;
    }
    return acc;
}

int main(void) {
    int value = factorial(5);
    if (value > 10) {
        printf("factorial: %d\n", value);
    } else {
        return -1;
    }
    return 0;
}
