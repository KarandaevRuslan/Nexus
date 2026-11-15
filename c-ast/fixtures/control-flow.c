// Subset C: pointers, arrays, precedence and control flow
int sum(int *data, int count);
int counter = 0;
int samples[3];
int sum(int *data, int count) {
    int i = 0, result = 0;
    while (i < count) {
        result += data[i++];
    }
    do { counter++; } while (counter < 2);
    return result;
}
